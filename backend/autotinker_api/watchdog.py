"""The watchdog: a run that has gone quiet or run past its deadline is marked `timed_out` and its runner stopped.

There is no cron: it runs lazily wherever a run is read (GET run, the SSE loop, a session load, a message) and over
all active runs when a new run starts. `timed_out` keeps every event and experiment, so the UI still shows the best
model so far; only the locked-test score and the report are missing.

    quiet:    no event and no heartbeat for AUTOTINKER_STALL_MINUTES (default 10). Both runners heartbeat every
              minute while the engine process lives, so this means the engine or its forwarder is gone.
    deadline: runs.deadline_at (sandbox: VM limit + 2 min; local: AUTOTINKER_RUN_TIMEOUT_S).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from autotinker_api import repo, settings
from autotinker_api.db import Conn
from autotinker_api.runners import get_runner

log = logging.getLogger("autotinker.watchdog")


def stall_limit() -> timedelta:
    return timedelta(minutes=settings.env_int("AUTOTINKER_STALL_MINUTES", 10))


def overdue(run: dict[str, Any], now: datetime | None = None) -> str | None:
    """Why an active run should be timed out, or None."""
    if run["status"] not in repo.ACTIVE:
        return None
    t = now or datetime.now(UTC)
    deadline = run.get("deadline_at")
    if deadline is not None and t > deadline:
        return "deadline"
    seen = run.get("last_seen_at") or run["created_at"]
    if t - seen > stall_limit():
        return "quiet"
    return None


MESSAGES = {
    "deadline": "The run hit its time limit. Every experiment so far is kept; there is no locked-test score.",
    "quiet": "The engine stopped responding. Every experiment so far is kept; there is no locked-test score.",
}


async def enforce(conn: Conn, run: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """Time the run out if it is overdue (and stop its runner). Returns the current row."""
    why = overdue(run, now)
    if why is None:
        return run
    updated = await repo.finish_run(conn, run["id"], "timed_out", error=MESSAGES[why])
    if updated is None:  # it ended meanwhile
        return await repo.get_run(conn, run["id"]) or run
    log.warning("[run %s] timed out (%s)", run["id"], why)
    try:
        await get_runner(run["runner"]).cancel(run)
    except Exception as e:  # noqa: BLE001 - best effort; the VM limit stops it anyway
        log.warning("[run %s] stopping the timed-out run failed (%s)", run["id"], type(e).__name__)
    return {**run, **updated}


async def sweep(conn: Conn, now: datetime | None = None) -> int:
    n = 0
    for run in await repo.active_runs(conn):
        if overdue(run, now):
            await enforce(conn, run, now)
            n += 1
    return n
