"""Sandbox runner (production default): one Vercel Sandbox microVM per run.

    POST /api/runs ─► (background) create sandbox ─► restore the engine from a snapshot, or install it (~10 s) and
                      snapshot it for next time ─► write run.sh / forward.py / control.jsonl [/ input.csv]
                      ─► lock egress down ─► start run.sh, detached ─► return
    in the VM:  autotinker run … --events-stdout --control-file control.jsonl --max-time <limit − 3 min>
                  | forward.py ─► POST /api/runs/<id>/ingest  (events, a heartbeat every minute, run.json, exit code)
                    forward.py ─► PUT presigned Blob URL       (the files of `assets_ready`, straight to Vercel Blob)
    steer/stop: append to control.jsonl through the sandbox filesystem API (the engine polls it)
    cancel:     box.stop()   ·   the exit post and the watchdog also stop the box

Secrets never enter the VM: the provider keys and the deployment-protection bypass are injected as request headers by
the sandbox firewall (credentials brokering); the engine sees placeholder values only. The per-run ingest token is the
one credential the VM holds; it is scoped to this run and stored hashed. BLOB_READ_WRITE_TOKEN never enters the VM
either: for each file the API hands out a presigned PUT URL for exactly `runs/<run id>/<name>`, size-capped and valid
for minutes (see blob.py), and the VM may reach the Blob API host without any injected header.

Limits: AUTOTINKER_SANDBOX_MINUTES (default 40, Hobby allows 45) is the VM's execution limit; the engine gets
`--max-time` = limit − 3 min, so it finishes (locked test + report) before the VM is killed.

Snapshot: after the first fresh install the VM's filesystem is snapshotted and its id stored in app_settings under a
key derived from the engine package spec and the deployment's commit, so a new deploy builds a new one. Later runs
start from it and skip the install. AUTOTINKER_SANDBOX_SNAPSHOT_ID pins one explicitly; AUTOTINKER_SANDBOX_SNAPSHOTS=0
turns snapshots off. A snapshot that can't be restored is forgotten and the run falls back to installing.
"""

from __future__ import annotations

import hashlib
import logging
import subprocess
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from autotinker_api import blob, db, repo, settings
from autotinker_api.runners.base import ControlCommand, StartRequest, engine_args

log = logging.getLogger("autotinker.runner.sandbox")

WORK = "/vercel/work"  # the universal image's cwd is /vercel
CONTROL = f"{WORK}/control.jsonl"
DEFAULT_PACKAGE = "autotinker @ git+https://github.com/Sakalya100/AutoTabML@v2"
INSTALL_HOSTS = [
    "github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",  # uv's python-build-standalone downloads
    "pypi.org",
    "files.pythonhosted.org",
    "astral.sh",
    "*.astral.sh",
]
PLACEHOLDER_KEY = "brokered-by-sandbox-firewall"
PROVIDER_HOSTS = {
    "GROQ_API_KEY": "api.groq.com",
    "GEMINI_API_KEY": "generativelanguage.googleapis.com",
    "CEREBRAS_API_KEY": "api.cerebras.ai",
}

# Runs inside the VM (stdlib only): streams the engine's JSONL to the ingest route, uploads the run's files to Blob when
# the stream ends, and with `--final` posts run.json and the exit code. See forward.py.
FORWARD_PY = Path(__file__).with_name("forward.py").read_text()

RUN_SH = f"""#!/bin/bash
set -o pipefail
cd {WORK}
.venv/bin/python -m autotinker "$@" 2> stderr.log | .venv/bin/python forward.py --out {WORK}/out 2> forward.log
code=${{PIPESTATUS[0]}}
.venv/bin/python forward.py --final "$code" {WORK}/out stderr.log forward.log 2>> forward.log
"""


class StartError(RuntimeError):
    def __init__(self, message: str, tail: str = "") -> None:
        super().__init__(message)
        self.tail = tail


def limit_minutes() -> int:
    return max(5, settings.env_int("AUTOTINKER_SANDBOX_MINUTES", 40))


def engine_max_time_s() -> int:
    return max(60, (limit_minutes() - 3) * 60)


def package_spec() -> str:
    return settings.env("AUTOTINKER_SANDBOX_PACKAGE") or DEFAULT_PACKAGE


def snapshot_key() -> str:
    raw = f"{package_spec()}|{settings.env('VERCEL_GIT_COMMIT_SHA') or ''}"
    return "sandbox_snapshot:" + hashlib.sha256(raw.encode()).hexdigest()[:16]


def dataset_hosts(url: str | None) -> list[str]:
    host = (urlsplit(url or "").hostname or "").lower()
    hosts = [host] if host else []
    if host == "github.com":  # the engine rewrites github.com/…/blob/… links to raw.githubusercontent.com
        hosts.append("raw.githubusercontent.com")
    if host == "drive.google.com":  # Drive downloads redirect to its content host
        hosts.append("drive.usercontent.google.com")
    return hosts


def run_policy(dataset_url: str | None, ingest_host: str, env: dict[str, str]) -> Any:
    """Run-phase egress: LLM providers (keys brokered), the dataset host, our own ingest host and, when a Blob store is
    configured, the Blob API host (no credential: the VM uploads with presigned URLs scoped to one pathname each)."""
    from vercel.sandbox import NetworkPolicy, NetworkPolicyRule, NetworkPolicyTransform

    def brokered(headers: dict[str, str]) -> list[Any]:
        return [NetworkPolicyRule(transform=[NetworkPolicyTransform(headers=headers)])]

    allow: dict[str, list[Any]] = {h: [] for h in dataset_hosts(dataset_url)}
    bypass = env.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    allow[ingest_host] = brokered({"x-vercel-protection-bypass": bypass}) if bypass else []
    for key, host in PROVIDER_HOSTS.items():
        if env.get(key):
            allow[host] = brokered({"Authorization": f"Bearer {env[key]}"})
    if env.get("BLOB_READ_WRITE_TOKEN"):
        allow.setdefault(blob_api_host(env), [])
    return NetworkPolicy.custom(allow=allow)


def blob_api_host(env: dict[str, str]) -> str:
    return urlsplit(env.get("VERCEL_BLOB_API_URL") or blob.DEFAULT_API).hostname or "vercel.com"


def engine_env(env: dict[str, str]) -> dict[str, str]:
    """Placeholders only: the real keys are added to requests by the firewall, never visible in the VM."""
    out = {k: PLACEHOLDER_KEY for k in PROVIDER_HOSTS if env.get(k)}
    disabled = env.get("AUTOTINKER_DISABLED_PROVIDERS")
    if disabled:
        out["AUTOTINKER_DISABLED_PROVIDERS"] = disabled
    return out


class SandboxRunner:
    kind: Literal["local", "sandbox"] = "sandbox"

    def __init__(self, env: dict[str, str] | None = None) -> None:
        self._env = env

    @property
    def env(self) -> dict[str, str]:
        import os

        return dict(os.environ if self._env is None else self._env)

    async def start(self, req: StartRequest) -> None:
        run = req.run
        run_id = run["id"]
        async with db.connection() as conn:
            await repo.update_run(conn, run_id, only_if_active=True, status="starting")
            t0 = time.monotonic()
            try:
                name, timings = await self._launch(conn, req)
            except StartError as e:
                log.error("[run %s] sandbox start failed: %s", run_id, e)
                await repo.finish_run(
                    conn, run_id, "failed", error=str(e), error_tail=settings.redact(e.tail)[-4000:] or None
                )
                return
            timings["start_request_s"] = round(time.monotonic() - t0, 2)
            log.info("[run %s] sandbox %s started: %s", run_id, name, timings)
            await repo.update_run(conn, run_id, timings=timings)

    async def _launch(self, conn: db.Conn, req: StartRequest) -> tuple[str, dict[str, Any]]:
        from vercel import sandbox
        from vercel.sandbox import SandboxResources, SnapshotSource

        run = req.run
        run_id = run["id"]
        env = self.env
        name = f"autotinker-{run_id}"
        vcpus = settings.env_int("AUTOTINKER_SANDBOX_VCPUS", 2)
        limit = timedelta(minutes=limit_minutes())
        common: dict[str, Any] = {
            "resources": SandboxResources(vcpus=vcpus, memory=vcpus * 2048),
            "execution_time_limit": limit,
            "persistent": False,
            "tags": {"app": "autotinker", "run": run_id},
        }
        policy = run_policy(run["source_url"], urlsplit(req.ingest_url).hostname or "", env)
        timings: dict[str, Any] = {}
        use_snapshots = env.get("AUTOTINKER_SANDBOX_SNAPSHOTS") != "0"
        key = snapshot_key()
        snap_id = env.get("AUTOTINKER_SANDBOX_SNAPSHOT_ID") or (
            await repo.get_setting(conn, key) if use_snapshots else None
        )

        box: Any = None
        if snap_id:
            t = time.monotonic()
            try:
                box = await sandbox.create_sandbox(
                    name=name, source=SnapshotSource(snapshot_id=snap_id), network_policy=policy, **common
                )
                timings.update(restore_s=round(time.monotonic() - t, 2), snapshot_id=snap_id)
            except Exception as e:  # noqa: BLE001 - expired/deleted snapshot: forget it and install
                log.warning("[run %s] snapshot %s unusable (%s); installing", run_id, snap_id, type(e).__name__)
                if not env.get("AUTOTINKER_SANDBOX_SNAPSHOT_ID"):
                    await repo.delete_setting(conn, key)
                box = None
        if box is None:
            box = await self._fresh_install(conn, name, run_id, common, key, use_snapshots, timings)
            try:
                if timings.get("snapshot_id"):
                    t = time.monotonic()
                    box = await sandbox.create_sandbox(
                        name=name,
                        source=SnapshotSource(snapshot_id=timings["snapshot_id"]),
                        network_policy=policy,
                        **common,
                    )
                    timings["restore_s"] = round(time.monotonic() - t, 2)
                else:
                    await box.update_network_policy(policy)
            except Exception as e:  # noqa: BLE001
                raise StartError(f"Starting the sandbox failed ({type(e).__name__}).") from e

        name = str(getattr(box, "name", None) or name)
        await repo.update_run(conn, run_id, runner_ref=name)
        try:
            t = time.monotonic()
            async with box.fs.batch(cwd=WORK) as batch:
                batch.write_text("forward.py", FORWARD_PY)
                batch.write_text("run.sh", RUN_SH, mode=0o755)
                batch.write_text("control.jsonl", "")
            if run["source"] == "file":
                if req.csv is None:
                    raise StartError("The uploaded file was lost before the sandbox started.")
                await box.fs.write_bytes(f"{WORK}/input.csv", req.csv)
            source = f"{WORK}/input.csv" if run["source"] == "file" else run["source_url"]
            args = engine_args(
                source=source,
                target=run["target"],
                metric=run["metric"],
                goal=run["goal"],
                max_experiments=run["max_experiments"],
                out_dir=f"{WORK}/out",
                control_file=CONTROL,
                max_time_s=engine_max_time_s(),
            )
            await box.create_process(
                "bash",
                [f"{WORK}/run.sh", *args],
                cwd=WORK,
                env={
                    **engine_env(env),
                    "INGEST_URL": req.ingest_url,
                    "INGEST_TOKEN": req.ingest_token,
                    "PYTHONUNBUFFERED": "1",
                },
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            timings["start_s"] = round(time.monotonic() - t, 2)
        except BaseException as exc:
            await _quiet_stop(box)
            if isinstance(exc, StartError):
                raise
            raise StartError(f"Starting the run in the sandbox failed ({type(exc).__name__}).") from exc
        return name, timings

    async def _fresh_install(
        self,
        conn: db.Conn,
        name: str,
        run_id: str,
        common: dict[str, Any],
        key: str,
        use_snapshots: bool,
        timings: dict[str, Any],
    ) -> Any:
        """Create a VM that may reach the package indexes only, install the engine, and (once per key) snapshot it.
        Snapshotting stops the VM; the caller then starts the run's VM from the snapshot."""
        from vercel import sandbox
        from vercel.sandbox import NetworkPolicy

        t = time.monotonic()
        build_name = f"{name}-build" if use_snapshots else name
        try:
            box = await sandbox.create_sandbox(
                name=build_name, network_policy=NetworkPolicy.custom(allow={h: [] for h in INSTALL_HOSTS}), **common
            )
        except Exception as e:  # noqa: BLE001
            raise StartError(f"Creating the sandbox failed ({type(e).__name__}).") from e
        timings["create_s"] = round(time.monotonic() - t, 2)
        t = time.monotonic()
        try:
            install = await box.run_process(
                "bash",
                [
                    "-lc",
                    f"mkdir -p {WORK} && cd {WORK} && uv venv -q --python 3.12 .venv"
                    f" && uv pip install -q --python .venv/bin/python '{package_spec()}'",
                ],
                capture_output=True,
            )
        except Exception as e:  # noqa: BLE001
            await _quiet_stop(box)
            raise StartError(f"Installing the engine in the sandbox failed ({type(e).__name__}).") from e
        if install.returncode != 0:
            await _quiet_stop(box)
            tail = "\n".join(str(install.stderr or "").splitlines()[-20:])
            raise StartError("Installing the engine in the sandbox failed.", tail)
        timings["install_s"] = round(time.monotonic() - t, 2)
        if not use_snapshots:
            return box
        t = time.monotonic()
        try:
            days = settings.env_int("AUTOTINKER_SANDBOX_SNAPSHOT_DAYS", 30)
            snap = await box.snapshot(expiration=timedelta(days=days))
            await repo.set_setting(conn, key, snap.id)
            await _quiet_stop(box)  # in case snapshotting left the build VM running; the run starts from the snapshot
            timings.update(snapshot_s=round(time.monotonic() - t, 2), snapshot_id=snap.id, snapshot_built=True)
            log.info("[run %s] built sandbox snapshot %s in %.1fs", run_id, snap.id, timings["snapshot_s"])
        except Exception as e:  # noqa: BLE001 - run without one; try again next time
            log.warning("[run %s] snapshot failed (%s); running on the install VM", run_id, type(e).__name__)
        return box

    async def control(self, run: dict[str, Any], cmd: ControlCommand) -> bool:
        """Append to the engine's control file (read, append, write back; the engine re-reads a rewritten file)."""
        import json

        from vercel import sandbox

        name = run.get("runner_ref")
        if not name:
            return False
        try:
            box = await sandbox.get_sandbox(name=name)
            try:
                current = await box.fs.read_text(CONTROL)
            except Exception:  # noqa: BLE001 - not written yet
                current = ""
            await box.fs.write_text(CONTROL, current + json.dumps(cmd) + "\n")
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("[run %s] control %s not delivered (%s)", run["id"], cmd.get("type"), type(e).__name__)
            return False

    async def cancel(self, run: dict[str, Any]) -> bool:
        from vercel import sandbox

        name = run.get("runner_ref")
        if not name:
            return False
        try:
            box = await sandbox.get_sandbox(name=name)
            await box.stop()
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("[run %s] sandbox stop failed (%s)", run["id"], type(e).__name__)
            return False


async def _quiet_stop(box: Any) -> None:
    try:
        await box.stop()
    except Exception:  # noqa: BLE001
        pass


def deadline_for_new_run() -> datetime:
    """Sandbox runs: the VM limit plus a little slack for the final posts."""
    return datetime.now(UTC) + timedelta(minutes=limit_minutes() + 2)
