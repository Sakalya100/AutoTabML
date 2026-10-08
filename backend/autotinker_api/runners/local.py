"""Local runner (dev default): the engine as a child process of this API server.

    <AUTOTINKER_PYTHON_CMD> -m autotinker run <url|input.csv> --target T [--metric M] [--goal G]
        --max-experiments N --out <dir> --events-stdout --control-file <dir>/control.jsonl

AUTOTINKER_PYTHON_CMD defaults to `uv run --project <repo root> python` (split on whitespace). A background task reads
the engine's stdout JSONL into run_events (one Postgres connection for the run's lifetime) and touches the run's
`last_seen_at` every minute while the process lives, so the watchdog can tell quiet from dead.

Steering and stop are appended to the control file, which the engine polls; that keeps working across an API restart
as long as the engine process is alive. The process runs in its own process group (runner_ref = its pgid) so cancel
kills uv, python and the harness's experiment subprocesses together.

Environment: an allow-list of system variables plus provider keys and AUTOTINKER_* settings (settings.engine_env);
DATABASE_URL*, the session secret and other credentials are blanked. Generated pipelines are sandboxed by the
engine's own harness, not by this process; only run this runner on a machine you trust with the data.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import signal
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from autotinker_api import background, db, repo, settings
from autotinker_api.events import JsonlDecoder
from autotinker_api.runners.base import ControlCommand, StartRequest, engine_args, exit_status

log = logging.getLogger("autotinker.runner.local")
HEARTBEAT_S = 60

_live: dict[str, asyncio.subprocess.Process] = {}
_cancelled: set[str] = set()


def data_root() -> Path:
    return Path(settings.env("AUTOTINKER_DATA_DIR") or settings.BACKEND_DIR / ".data")


def run_dir(run_id: str) -> Path:
    if not repo.valid_run_id(run_id):
        raise ValueError("invalid run id")
    return data_root() / "runs" / run_id


def python_command() -> list[str]:
    raw = (settings.env("AUTOTINKER_PYTHON_CMD") or "").strip()
    return raw.split() if raw else ["uv", "run", "--project", str(settings.REPO_ROOT), "python"]


def active_local_runs() -> int:
    return len(_live)


def _find_record(out_dir: Path) -> dict[str, Any] | None:
    for p in [out_dir / "run.json", *sorted(out_dir.glob("*/run.json"))]:
        if p.is_file():
            try:
                rec = json.loads(p.read_text())
                return rec if isinstance(rec, dict) else None
            except (OSError, ValueError):
                return None
    return None


def _alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _signal(pgid: int, sig: int) -> bool:
    try:
        os.killpg(pgid, sig)
        return True
    except (ProcessLookupError, PermissionError):
        return False


class LocalRunner:
    kind: Literal["local", "sandbox"] = "local"

    async def start(self, req: StartRequest) -> None:
        run = req.run
        run_id = run["id"]
        work = run_dir(run_id)
        out_dir = work / "out"
        control = work / "control.jsonl"
        out_dir.mkdir(parents=True, exist_ok=True)
        control.touch()
        if run["source"] == "file":
            if req.csv is None:
                raise ValueError("an uploaded-file run needs its CSV")
            (work / "input.csv").write_bytes(req.csv)
            source = str(work / "input.csv")
        else:
            source = run["source_url"]
        max_s = settings.env_int("AUTOTINKER_RUN_TIMEOUT_S", 3600)
        args = engine_args(
            source=source,
            target=run["target"],
            metric=run["metric"],
            goal=run["goal"],
            max_experiments=run["max_experiments"],
            out_dir=str(out_dir),
            control_file=str(control),
        )
        cmd = [*python_command(), "-m", "autotinker", *args]
        log.info("[run %s] spawn: %s", run_id, shlex.join(cmd))  # argv only, never the env
        async with db.connection() as conn:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    cwd=str(settings.REPO_ROOT),
                    env=settings.engine_env(),
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                    limit=8 * 1024 * 1024,
                )
            except OSError as e:
                status, error = exit_status(code=None, cancelled=False, has_record=False, spawn_error=str(e))
                await repo.finish_run(conn, run_id, status, error=error)
                return
            _live[run_id] = proc
            await repo.update_run(
                conn,
                run_id,
                only_if_active=True,
                status="starting",
                runner_ref=str(proc.pid),
                deadline_at=datetime.fromtimestamp(datetime.now(UTC).timestamp() + max_s, UTC),
                timings={"spawned_at": datetime.now(UTC).isoformat()},
            )
        background.spawn(self._supervise(run_id, proc, out_dir, work, max_s), name=f"supervise-{run_id}")

    async def _supervise(
        self, run_id: str, proc: asyncio.subprocess.Process, out_dir: Path, work: Path, max_s: int
    ) -> None:
        secrets = settings.known_secrets()
        tail: list[str] = []
        decoder = JsonlDecoder()
        conn = await db.connect()
        try:

            async def read_stdout() -> None:
                assert proc.stdout is not None
                while True:
                    chunk = await proc.stdout.read(65536)
                    if not chunk:
                        break
                    events = decoder.push(chunk.decode("utf-8", errors="replace"))
                    if events:
                        await repo.append_events(conn, run_id, events)
                events = decoder.end()
                if events:
                    await repo.append_events(conn, run_id, events)
                for line in decoder.other:
                    log.info("[run %s] stdout: %s", run_id, settings.redact(line, secrets)[:500])

            async def read_stderr() -> None:
                assert proc.stderr is not None
                async for raw in proc.stderr:
                    line = settings.redact(raw.decode("utf-8", errors="replace").rstrip("\n"), secrets)
                    log.warning("[run %s] stderr: %s", run_id, line)
                    tail.append(line)
                    del tail[:-60]

            async def heartbeat() -> None:
                while True:
                    await asyncio.sleep(HEARTBEAT_S)
                    await repo.touch_seen(conn, run_id)

            beat = asyncio.create_task(heartbeat())
            try:
                await asyncio.wait_for(asyncio.gather(read_stdout(), read_stderr(), proc.wait()), timeout=max_s)
            except TimeoutError:
                log.warning("[run %s] exceeded %ss, killing", run_id, max_s)
                _signal(proc.pid, signal.SIGKILL)
                await proc.wait()
            finally:
                beat.cancel()
            record = _find_record(out_dir)
            if record is not None:
                await repo.update_run(conn, run_id, record=record)
            (work / "input.csv").unlink(missing_ok=True)  # uploads are not kept after the run
            root = str(settings.REPO_ROOT)
            error_tail = "\n".join(ln.replace(root, "…") for ln in tail[-40:] if not ln.startswith("run directory:"))
            status, error = exit_status(
                code=proc.returncode, cancelled=run_id in _cancelled, has_record=record is not None
            )
            await repo.finish_run(
                conn, run_id, status, error=error, error_tail=error_tail if status == "failed" else None
            )
            log.info("[run %s] %s (exit %s)", run_id, status, proc.returncode)
        except Exception:
            log.exception("[run %s] supervisor failed", run_id)
            if proc.returncode is None:
                _signal(proc.pid, signal.SIGTERM)
        finally:
            _live.pop(run_id, None)
            _cancelled.discard(run_id)
            await conn.close()

    async def control(self, run: dict[str, Any], cmd: ControlCommand) -> bool:
        pgid = _pgid(run)
        if pgid is None or not _alive(pgid):
            return False
        try:
            with (run_dir(run["id"]) / "control.jsonl").open("a") as f:
                f.write(json.dumps(cmd) + "\n")
            return True
        except OSError:
            return False

    async def cancel(self, run: dict[str, Any]) -> bool:
        pgid = _pgid(run)
        if pgid is None or not _signal(pgid, signal.SIGTERM):
            return False
        _cancelled.add(run["id"])

        async def escalate() -> None:
            await asyncio.sleep(5)
            if _alive(pgid):
                _signal(pgid, signal.SIGKILL)

        background.spawn(escalate(), name=f"escalate-{run['id']}")
        return True


def _pgid(run: dict[str, Any]) -> int | None:
    ref = run.get("runner_ref")
    try:
        return int(ref) if ref else None
    except ValueError:
        return None
