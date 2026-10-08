"""Work that outlives the request that started it (sandbox create + install, the local runner's stdout reader).

On Vercel the invocation must be kept alive for it: `vercel.functions.wait_until` does that when the Python runtime
provides its request context. Without that context `wait_until` silently does nothing, so `spawn` always schedules
the work as an asyncio task itself and only *registers* it with wait_until. Routes that start long work on Vercel
also attach the task to the response's BackgroundTasks when wait_until isn't available (`needs_response_hold`),
which keeps the ASGI call (and with it the invocation) open until the work is done. Either way the work is bounded
by the function's maxDuration (vercel.json: 300 s), and the watchdog marks a run that never got going.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

from autotinker_api import settings

log = logging.getLogger("autotinker.background")
_tasks: set[asyncio.Task[Any]] = set()


def _wait_until_hook() -> Any:
    try:
        from vercel.cache.context import get_context
    except ImportError:  # pragma: no cover - the SDK is a dependency
        return None
    return get_context().wait_until


def spawn(coro: Coroutine[Any, Any, Any], name: str = "") -> tuple[asyncio.Task[Any], bool]:
    """Schedule `coro`. Returns (task, kept_alive_by_wait_until)."""
    task = asyncio.get_running_loop().create_task(coro, name=name or None)
    _tasks.add(task)
    task.add_done_callback(_done)
    hook = _wait_until_hook()
    if hook is not None:
        hook(task)
        return task, True
    return task, False


def needs_response_hold(registered: bool) -> bool:
    """On Vercel without a wait_until context, hold the response's ASGI call open until the task ends."""
    return settings.on_vercel() and not registered


async def join(task: asyncio.Task[Any]) -> None:
    try:
        await task
    except Exception:  # already logged by _done
        pass


def _done(task: asyncio.Task[Any]) -> None:
    _tasks.discard(task)
    if not task.cancelled() and task.exception() is not None:
        log.error("background task %s failed: %r", task.get_name(), task.exception())


async def drain(timeout_s: float = 5.0) -> None:
    """Tests: wait for scheduled background work."""
    if _tasks:
        await asyncio.wait(list(_tasks), timeout=timeout_s)
