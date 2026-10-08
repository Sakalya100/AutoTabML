"""Runs one AutoTinker job in a Vercel Sandbox (SPIKE).

    POST /py/runs ─► create sandbox (install-only egress) ─► uv venv + pip install the engine (~10 s)
                  ─► write run.sh / forward.py / control.jsonl ─► lock egress down ─► start run.sh, detached ─► return
    in the VM:   autotinker run … --events-stdout --control-file control.jsonl | forward.py ─► POST /py/runs/<id>/ingest
    stop:        append {"type":"stop"} to control.jsonl via box.fs (graceful); cancel = box.stop() (hard)

Secrets never enter the VM: the Groq/Gemini keys and the deployment-protection bypass are injected as headers by
the sandbox firewall (credentials brokering). The engine only sees placeholder key values so its router enables the
providers. The per-run ingest token is the one credential the VM holds; it is scoped to this run and stored hashed.
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from datetime import timedelta
from urllib.parse import urlsplit

from vercel import sandbox
from vercel.sandbox import NetworkPolicy, NetworkPolicyRule, NetworkPolicyTransform, SandboxResources

WORK = "/vercel/work"  # the universal image's cwd is /vercel; /vercel/sandbox does not exist there
CONTROL = f"{WORK}/control.jsonl"
DEFAULT_PACKAGE = "autotinker @ git+https://github.com/Sakalya100/AutoTabML@spike/fastapi-sandbox"
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

# Runs inside the VM. stdlib only. Streams JSONL from stdin to the ingest route in small batches (≤1 s latency);
# `--final CODE FILE…` posts the exit code and the tail of the given log files.
FORWARD_PY = r'''
import json, os, queue, sys, threading, time, urllib.request

URL = os.environ["INGEST_URL"]
TOKEN = os.environ["INGEST_TOKEN"]


def post(body):
    data = json.dumps(body).encode()
    for attempt in range(6):
        try:
            req = urllib.request.Request(URL, data=data, method="POST", headers={
                "Content-Type": "application/json", "X-Ingest-Token": TOKEN})
            with urllib.request.urlopen(req, timeout=30) as r:
                r.read()
            return True
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("[forward] ingest attempt %d failed: %s\n" % (attempt + 1, e))
            time.sleep(min(2 ** attempt, 15))
    return False


def final(code, paths):
    tail = []
    for p in paths:
        try:
            tail += open(p, errors="replace").read().splitlines()[-30:]
        except OSError:
            pass
    post({"kind": "exit", "exit_code": int(code), "stderr_tail": "\n".join(tail[-60:])})


def stream():
    q = queue.Queue()

    def reader():
        for line in sys.stdin:
            if line.strip():
                q.put(line.rstrip("\n"))
        q.put(None)

    threading.Thread(target=reader, daemon=True).start()
    buf, last, done = [], time.monotonic(), False
    while not done:
        try:
            item = q.get(timeout=0.5)
            if item is None:
                done = True
            else:
                buf.append(item)
        except queue.Empty:
            pass
        if buf and (done or len(buf) >= 50 or time.monotonic() - last >= 1.0):
            post({"kind": "events", "lines": buf})
            buf, last = [], time.monotonic()


if sys.argv[1:2] == ["--final"]:
    final(sys.argv[2], sys.argv[3:])
else:
    stream()
'''

RUN_SH = f"""#!/bin/bash
set -o pipefail
cd {WORK}
.venv/bin/autotinker run "$AT_URL" --target "$AT_TARGET" --max-experiments "$AT_MAX" --max-time "$AT_MAX_TIME" \\
  --events-stdout --control-file {CONTROL} --out {WORK}/out 2> stderr.log \\
  | .venv/bin/python forward.py 2> forward.log
code=${{PIPESTATUS[0]}}
.venv/bin/python forward.py --final "$code" stderr.log forward.log 2>> forward.log
"""


@dataclass(frozen=True)
class StartResult:
    sandbox_name: str
    session_id: str
    create_s: float
    install_s: float
    start_s: float


class StartError(RuntimeError):
    def __init__(self, message: str, sandbox_name: str | None = None, tail: str = "") -> None:
        super().__init__(message)
        self.sandbox_name = sandbox_name
        self.tail = tail


def _brokered(headers: dict[str, str]) -> list[NetworkPolicyRule]:
    return [NetworkPolicyRule(transform=[NetworkPolicyTransform(headers=headers)])]


def dataset_hosts(url: str) -> list[str]:
    host = (urlsplit(url).hostname or "").lower()
    hosts = [host] if host else []
    if host == "github.com":  # the engine rewrites github.com/…/blob/… links to raw.githubusercontent.com
        hosts.append("raw.githubusercontent.com")
    return hosts


def run_policy(dataset_url: str, ingest_host: str, env: dict[str, str]) -> NetworkPolicy:
    """Run-phase egress: LLM providers (keys brokered), the dataset host and our own ingest host only."""
    allow: dict[str, list[NetworkPolicyRule]] = {}
    for h in dataset_hosts(dataset_url):
        allow[h] = []
    bypass = env.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    allow[ingest_host] = _brokered({"x-vercel-protection-bypass": bypass}) if bypass else []
    if env.get("GROQ_API_KEY"):
        allow["api.groq.com"] = _brokered({"Authorization": f"Bearer {env['GROQ_API_KEY']}"})
    if env.get("GEMINI_API_KEY"):
        allow["generativelanguage.googleapis.com"] = _brokered(
            {"Authorization": f"Bearer {env['GEMINI_API_KEY']}"}
        )
    return NetworkPolicy.custom(allow=allow)


def engine_env(env: dict[str, str]) -> dict[str, str]:
    """Placeholders only: the real keys are added to requests by the firewall, never visible in the VM."""
    out = {"AUTOTINKER_DISABLED_PROVIDERS": env.get("AUTOTINKER_DISABLED_PROVIDERS", "cerebras")}
    for k in ("GROQ_API_KEY", "GEMINI_API_KEY"):
        if env.get(k):
            out[k] = PLACEHOLDER_KEY
    return out


class SandboxRunner:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        self.env = dict(os.environ if env is None else env)

    async def start(
        self, *, run_id: str, url: str, target: str, max_experiments: int, ingest_url: str, token: str
    ) -> StartResult:
        name = f"autotinker-spike-{run_id}"
        vcpus = int(self.env.get("AUTOTINKER_SANDBOX_VCPUS", "2"))
        limit_min = min(int(self.env.get("AUTOTINKER_SANDBOX_MINUTES", "20")), 30)
        t0 = time.monotonic()
        box = await sandbox.create_sandbox(
            name=name,
            resources=SandboxResources(vcpus=vcpus, memory=vcpus * 2048),
            execution_time_limit=timedelta(minutes=limit_min),
            persistent=False,
            network_policy=NetworkPolicy.custom(allow={h: [] for h in INSTALL_HOSTS}),
            tags={"app": "autotinker-spike", "run": run_id},
        )
        t1 = time.monotonic()
        try:
            pkg = self.env.get("AUTOTINKER_SANDBOX_PACKAGE", DEFAULT_PACKAGE)
            install = await box.run_process(
                "bash",
                [
                    "-lc",
                    f"mkdir -p {WORK} && cd {WORK} && uv venv -q --python 3.12 .venv"
                    f" && uv pip install -q --python .venv/bin/python '{pkg}'",
                ],
                capture_output=True,
            )
            if install.returncode != 0:
                tail = "\n".join(str(install.stderr or "").splitlines()[-20:])
                raise StartError("installing the engine in the sandbox failed", name, tail)
            t2 = time.monotonic()
            async with box.fs.batch(cwd=WORK) as batch:
                batch.write_text("forward.py", FORWARD_PY)
                batch.write_text("run.sh", RUN_SH, mode=0o755)
                batch.write_text("control.jsonl", "")
            ingest_host = urlsplit(ingest_url).hostname or ""
            await box.update_network_policy(run_policy(url, ingest_host, self.env))
            await box.create_process(
                "bash",
                [f"{WORK}/run.sh"],
                cwd=WORK,
                env={
                    **engine_env(self.env),
                    "AT_URL": url,
                    "AT_TARGET": target,
                    "AT_MAX": str(max_experiments),
                    "AT_MAX_TIME": str(max(60, (limit_min - 3) * 60)),
                    "INGEST_URL": ingest_url,
                    "INGEST_TOKEN": token,
                    "PYTHONUNBUFFERED": "1",
                },
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            t3 = time.monotonic()
        except BaseException as exc:
            await _quiet_stop(box)
            if isinstance(exc, StartError):
                raise
            raise StartError(f"starting the run failed: {type(exc).__name__}: {exc}", name) from exc
        return StartResult(name, box.current_session_id, t1 - t0, t2 - t1, t3 - t2)

    async def request_stop(self, sandbox_name: str) -> None:
        """Graceful stop: the engine polls control.jsonl, finishes the current step, runs the locked test + report."""
        box = await sandbox.get_sandbox(name=sandbox_name)
        try:
            current = await box.fs.read_text(CONTROL)
        except Exception:  # noqa: BLE001 - missing file
            current = ""
        await box.fs.write_text(CONTROL, current + '{"type":"stop"}\n')

    async def cancel(self, sandbox_name: str) -> None:
        box = await sandbox.get_sandbox(name=sandbox_name)
        await box.stop()

    async def usage(self, sandbox_name: str) -> dict[str, object]:
        box = await sandbox.get_sandbox(name=sandbox_name)
        raw = box.raw or {}
        keys = ("status", "totalActiveCpuDurationMs", "totalDurationMs", "totalEgressBytes", "totalIngressBytes")
        return {k: raw.get(k) for k in keys}


async def _quiet_stop(box: object) -> None:
    try:
        await box.stop()  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
