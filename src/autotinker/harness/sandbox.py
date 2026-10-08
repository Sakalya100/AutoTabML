"""Local subprocess sandbox for running solution code.

Isolation provided (local backend):
  * separate process in its own session / process group; the whole group is SIGKILLed on timeout or
    memory overrun
  * wall-clock timeout
  * memory limit: a parent-side watchdog sums the RSS of the worker's process group (via `ps`) every
    ~50 ms and kills it above the budget. This is the primary mechanism because macOS refuses
    RLIMIT_AS / RLIMIT_DATA / RLIMIT_RSS (setrlimit raises ValueError). The worker additionally applies
    RLIMIT_DATA/RLIMIT_AS where the kernel honours it (Linux) and maps MemoryError to error_kind="memory".
  * network blocked inside the worker before solution code is imported
  * minimal environment built from scratch (no API keys or other secrets inherited)
  * cwd is a fresh temp dir; stdout/stderr go to files and only tails are returned
Not provided: file-system isolation (the static check forbids file IO instead). Use a container backend
for untrusted multi-tenant use.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import autotinker

TAIL_LINES = 50
TAIL_CHARS = 4000
POLL_S = 0.05
POLL_SLOW_S = 0.2
ERROR_KINDS = frozenset({"static_check", "timeout", "memory", "runtime", "invalid_output"})


@dataclass
class SandboxResult:
    ok: bool
    duration_s: float
    payload: dict[str, Any] | None = None  # worker result.json when ok
    preds_path: Path | None = None
    error_kind: str | None = None
    error_tail: str | None = None
    stdout_tail: str | None = None
    peak_rss_mb: float = 0.0


def tail(text: str, lines: int = TAIL_LINES, chars: int = TAIL_CHARS) -> str:
    out = "\n".join(text.rstrip("\n").splitlines()[-lines:])
    return out[-chars:]


def _read_tail(path: Path) -> str:
    try:
        return tail(path.read_text(errors="replace"))
    except OSError:
        return ""


def minimal_env(tmp_dir: Path, threads: int) -> dict[str, str]:
    """A fresh environment: nothing from os.environ except a sanitised PATH and locale."""
    src_root = str(Path(autotinker.__file__).resolve().parent.parent)
    t = str(threads)
    return {
        "PATH": os.pathsep.join(p for p in ("/usr/bin", "/bin", str(Path(sys.executable).parent)) if p),
        "HOME": str(tmp_dir),
        "TMPDIR": str(tmp_dir),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONPATH": src_root,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "PYTHONHASHSEED": "0",
        "PYTHONNOUSERSITE": "1",
        "OMP_NUM_THREADS": t,
        "OPENBLAS_NUM_THREADS": t,
        "MKL_NUM_THREADS": t,
        "VECLIB_MAXIMUM_THREADS": t,
        "NUMEXPR_NUM_THREADS": t,
        "LOKY_MAX_CPU_COUNT": t,
        "MPLBACKEND": "Agg",
        "NO_PROXY": "*",
        "no_proxy": "*",
    }


def group_rss_kb(pgid: int) -> int:
    """Total resident set size (KB) of all processes in process group `pgid` (macOS and Linux `ps`)."""
    try:
        out = subprocess.run(
            ["ps", "-A", "-o", "pgid=,rss="], capture_output=True, text=True, timeout=5, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return 0
    total = 0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == str(pgid):
            with contextlib.suppress(ValueError):
                total += int(parts[1])
    return total


def _kill_group(proc: subprocess.Popen[bytes]) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGKILL)
    with contextlib.suppress(Exception):
        proc.kill()
    with contextlib.suppress(Exception):
        proc.wait(timeout=10)


def run_in_sandbox(
    code: str,
    *,
    mode: str,
    data_path: Path,
    job_dir: Path,
    profile: dict[str, Any],
    need_proba: bool,
    n_classes: int,
    timeout_s: float,
    memory_mb: int,
    seed: int = 0,
    threads: int | None = None,
    extra: dict[str, Any] | None = None,
) -> SandboxResult:
    """Run `code` (no static check here; callers do that) in a worker subprocess. Never raises for
    solution failures."""
    job_dir.mkdir(parents=True, exist_ok=True)
    solution_path = job_dir / "solution.py"
    solution_path.write_text(code)
    result_path, preds_path = job_dir / "result.json", job_dir / "preds.npz"
    stdout_path, stderr_path = job_dir / "stdout.log", job_dir / "stderr.log"
    for p in (result_path, preds_path):
        p.unlink(missing_ok=True)
    job = {
        "mode": mode,
        "solution_path": str(solution_path),
        "data_path": str(data_path),
        "result_path": str(result_path),
        "preds_path": str(preds_path),
        "profile": profile,
        "need_proba": need_proba,
        "n_classes": n_classes,
        "memory_mb": memory_mb,
        "seed": seed,
        **(extra or {}),
    }
    job_path = job_dir / "job.json"
    job_path.write_text(json.dumps(job))
    n_threads = threads if threads is not None else max(1, min(4, os.cpu_count() or 1))

    cwd = Path(tempfile.mkdtemp(prefix="autotinker-sbx-"))
    limit_kb = memory_mb * 1024
    killed: str | None = None
    peak_kb = 0
    t0 = time.monotonic()
    try:
        with stdout_path.open("wb") as out, stderr_path.open("wb") as err:
            proc = subprocess.Popen(
                [sys.executable, "-s", "-m", "autotinker.harness.worker", str(job_path)],
                cwd=cwd,
                env=minimal_env(cwd, n_threads),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                start_new_session=True,  # own process group -> killpg takes down any children too
                close_fds=True,
            )
            try:
                while proc.poll() is None:
                    if time.monotonic() - t0 > timeout_s:
                        killed = "timeout"
                        _kill_group(proc)
                        break
                    rss = group_rss_kb(proc.pid)
                    peak_kb = max(peak_kb, rss)
                    if rss > limit_kb:
                        killed = "memory"
                        _kill_group(proc)
                        break
                    # Poll fast at first (allocation bombs), then back off to limit `ps` spawns.
                    time.sleep(POLL_S if time.monotonic() - t0 < 2.0 else POLL_SLOW_S)
            finally:
                if proc.poll() is None:
                    _kill_group(proc)
                # Reap stragglers in the group even after a clean exit.
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(proc.pid, signal.SIGKILL)
        duration = time.monotonic() - t0
    finally:
        shutil.rmtree(cwd, ignore_errors=True)

    stderr_tail = _read_tail(stderr_path)
    stdout_tail = _read_tail(stdout_path) or None
    peak_mb = peak_kb / 1024
    if killed == "timeout":
        msg = f"TIMEOUT: killed after {timeout_s:.1f}s wall-clock (limit {timeout_s:.1f}s)"
        return SandboxResult(
            False,
            duration,
            error_kind="timeout",
            error_tail=tail(f"{stderr_tail}\n{msg}"),
            stdout_tail=stdout_tail,
            peak_rss_mb=peak_mb,
        )
    if killed == "memory":
        msg = f"MEMORY: killed at {peak_mb:.0f} MB resident (limit {memory_mb} MB)"
        return SandboxResult(
            False,
            duration,
            error_kind="memory",
            error_tail=tail(f"{stderr_tail}\n{msg}"),
            stdout_tail=stdout_tail,
            peak_rss_mb=peak_mb,
        )

    payload: dict[str, Any] | None = None
    with contextlib.suppress(OSError, ValueError):
        loaded = json.loads(result_path.read_text())
        payload = loaded if isinstance(loaded, dict) else None
    rc = proc.returncode
    if payload is None:
        if rc is not None and rc < 0:
            sig = -rc
            kind = "memory" if sig == signal.SIGKILL else "runtime"
            msg = f"worker killed by signal {sig}" + (" (likely out of memory)" if kind == "memory" else "")
        else:
            kind, msg = "runtime", f"worker exited with code {rc} without a result"
        return SandboxResult(
            False,
            duration,
            error_kind=kind,
            error_tail=tail(f"{stderr_tail}\n{msg}"),
            stdout_tail=stdout_tail,
            peak_rss_mb=peak_mb,
        )
    if payload.get("ok") is True and rc == 0 and preds_path.exists():
        return SandboxResult(
            True,
            duration,
            payload=payload,
            preds_path=preds_path,
            stdout_tail=stdout_tail,
            peak_rss_mb=peak_mb,
        )
    raw_kind = payload.get("error_kind")
    kind = raw_kind if isinstance(raw_kind, str) and raw_kind in ERROR_KINDS else "runtime"
    err_text = stderr_tail or str(payload.get("error", "unknown error"))
    return SandboxResult(
        False,
        duration,
        error_kind=kind,
        error_tail=tail(err_text),
        stdout_tail=stdout_tail,
        peak_rss_mb=peak_mb,
    )
