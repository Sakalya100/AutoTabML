"""Why a run failed, in plain language: the engine's own `run_failed` event when it sent one, else a best guess from
how the process ended (exit code, the tail of its stderr).

The codes are the engine's (src/autotinker/failures.py) plus what only the runner can see (killed for memory, the
run's time limit). The run row stores `error` (message), `error_code` and `error_hint`; the run meta exposes them as
`error`, `errorCode` and `hint`, and the web's failed-run card renders them (web/src/lib/run-failure.ts).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

CODES = (
    "download_failed",
    "not_csv",
    "file_not_found",
    "target_missing",
    "target_empty",
    "too_few_rows",
    "llm_unavailable",
    "out_of_memory",
    "out_of_time",
    "unexpected",
)


@dataclass(frozen=True)
class Failure:
    code: str
    message: str
    hint: str = ""


def _clip(v: object, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def from_event(ev: dict[str, Any] | None) -> Failure | None:
    """The engine's run_failed event, sanitised (it reaches the browser)."""
    if not ev or ev.get("type") != "run_failed":
        return None
    payload = ev.get("payload") if isinstance(ev.get("payload"), dict) else ev
    assert isinstance(payload, dict)
    code = str(payload.get("code") or "unexpected")
    message = _clip(payload.get("message"), 400)
    if not message:
        return None
    return Failure(code if code in CODES else "unexpected", message, _clip(payload.get("hint"), 600))


# Matched against the engine's stderr when it died without a run_failed event (an older engine, or a crash before
# the CLI could report). First match wins.
_TAIL_RULES: tuple[tuple[re.Pattern[str], Failure], ...] = tuple(
    (re.compile(p, re.IGNORECASE), f)
    for p, f in (
        (
            r"MemoryError|out of memory|Cannot allocate memory",
            Failure("out_of_memory", "The run ran out of memory.", "Try a smaller file (fewer rows or columns)."),
        ),
        (
            r"target column .{0,200} not found",
            Failure(
                "target_missing",
                "The column to predict isn't in this file.",
                "Open the setup again and pick one of the file's columns.",
            ),
        ),
        (
            r"HTTP \d{3}|timed out after|could not resolve|download failed|too many redirects|larger than the",
            Failure(
                "download_failed",
                "We couldn't download the file.",
                "Check that the link is public and points straight at the file, then retry.",
            ),
        ),
        (
            r"web page, not a data file|binary file|could not parse|could not decode",
            Failure(
                "not_csv",
                "That link didn't give us a table we can read.",
                "Use a direct link to a CSV or TSV file (on GitHub, the “Raw” button).",
            ),
        ),
        (
            r"no LLM provider|rate-limited|quota|no provider could serve",
            Failure(
                "llm_unavailable",
                "The AI models that plan the experiments are unavailable right now.",
                "They are probably out of quota for the moment. Retry in a few minutes.",
            ),
        ),
        (
            r"No such option|Usage: ",
            Failure(
                "unexpected",
                "The engine on this server is out of date and didn't accept the run's settings.",
                "This is on our side; retry later.",
            ),
        ),
    )
)


def from_exit(code: int | None, tail: str, *, timed_out: bool = False) -> Failure:
    """A best guess at why the engine process ended badly, when it didn't say."""
    if timed_out:
        return Failure(
            "out_of_time",
            "The run hit its time limit before it could finish.",
            "Retry with fewer experiments, or a smaller file.",
        )
    for pattern, failure in _TAIL_RULES:
        if pattern.search(tail or ""):
            return failure
    if code in (-9, 137):  # SIGKILL with no other explanation: almost always the OOM killer
        return Failure(
            "out_of_memory",
            "The run was stopped by the system, most likely because it ran out of memory.",
            "Try a smaller file (fewer rows or columns).",
        )
    last = next((ln.strip() for ln in reversed((tail or "").splitlines()) if ln.strip()), "")
    return Failure(
        "unexpected",
        "The run stopped on an unexpected error"
        + (f" (the engine exited with code {code})." if code is not None else "."),
        "Retry; if it fails again, the log below shows where it stopped." if last else "Retry in a minute.",
    )


def describe(event: dict[str, Any] | None, *, code: int | None, tail: str, timed_out: bool = False) -> Failure:
    return from_event(event) or from_exit(code, tail, timed_out=timed_out)
