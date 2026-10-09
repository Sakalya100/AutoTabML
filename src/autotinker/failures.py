"""Why a run could not go ahead, in plain language.

`autotinker run --events-stdout` ends a failed run with one `run_failed` event (obs/events.py `RunFailed`):

    {"type": "run_failed", "code": "target_missing", "message": "...", "hint": "...", "detail": "..."}

`message` and `hint` are written for the person who pasted the link; `detail` is the technical reason
(never a traceback). The web backend shows message + hint on the failed-run card and maps an engine that
died without saying why (killed, out of memory) onto the same codes (backend/autotinker_api/failures.py).

Codes:
    download_failed   the link could not be downloaded (HTTP error, timeout, blocked host, too large)
    not_csv           what we got is not a table we can read (a web page, binary, unparseable, one column)
    file_not_found    a local path that does not exist
    target_missing    the column to predict is not in the file (the hint lists close matches)
    target_empty      the column to predict has no values, or only one distinct value
    too_few_rows      fewer than MIN_ROWS rows with a value to predict
    llm_unavailable   no LLM provider is configured or every one is out of quota / refusing the key
    out_of_memory     the engine ran out of memory
    out_of_time       the run hit its time limit before it could finish (set by the backend)
    unexpected        anything else (the detail carries the exception's type and first line)
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass

import pandas as pd

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
MIN_ROWS = 20  # the web backend's MIN_DATA_ROWS for uploads


@dataclass(frozen=True)
class Failure:
    code: str
    message: str
    hint: str = ""
    detail: str = ""


class RunError(ValueError):
    """A run that cannot go ahead, with a user-facing message and hint."""

    def __init__(self, code: str, message: str, hint: str = "", detail: str = "") -> None:
        super().__init__(detail or message)
        self.failure = Failure(code, message, hint, detail or message)


def _short(text: str, n: int = 300) -> str:
    line = " ".join(str(text).split())
    return line if len(line) <= n else line[: n - 1] + "…"


def _names(columns: list[str], n: int = 8) -> str:
    shown = ", ".join(f'"{c}"' for c in columns[:n])
    return shown + (f" and {len(columns) - n} more" if len(columns) > n else "")


def target_missing(target: str, columns: list[str]) -> RunError:
    cols = [str(c) for c in columns]
    detail = f"target column {target!r} not found; columns: {cols[:50]}"
    message = f'The column "{target}" isn\'t in this file.'
    folded = [c for c in cols if c.strip().lower() == target.strip().lower()]
    close = folded or difflib.get_close_matches(target, cols, n=3, cutoff=0.6)
    if len(cols) == 1 and any(d in cols[0] for d in (";", "\t", "|")):
        hint = (
            "The file was read as a single column, so its separator was probably misdetected. "
            "Open the setup again so the preview can detect it."
        )
    elif close:
        hint = (
            "Did you mean " + " or ".join(f'"{c}"' for c in close) + "? Pick it in the setup and run again."
        )
    else:
        hint = f"Its columns are {_names(cols)}. Pick one of them in the setup."
    return RunError("target_missing", message, hint, detail)


def check_data(df: pd.DataFrame, target: str | None) -> None:
    """Fail early, with a plain reason, on data no experiment could learn from."""
    if df.shape[1] < 2:
        raise RunError(
            "not_csv",
            "We found only one column in this file.",
            "Check that it's a CSV or TSV with a header row and at least two columns.",
            f"columns: {[str(c) for c in df.columns]}",
        )
    if target is None:
        return
    if target not in df.columns:
        raise target_missing(target, [str(c) for c in df.columns])
    y = df[target]
    n = int(y.notna().sum())
    if n == 0:
        raise RunError(
            "target_empty",
            f'The column "{target}" is empty: every row is missing its value.',
            "Pick a column that has values to learn from.",
            f"target {target!r}: 0 of {len(df)} rows have a value",
        )
    if int(y.nunique(dropna=True)) < 2:
        raise RunError(
            "target_empty",
            f'Every row has the same value in "{target}", so there is nothing to predict.',
            "Pick a column whose values vary from row to row.",
            f"target {target!r} has a single distinct value",
        )
    if n < MIN_ROWS:
        raise RunError(
            "too_few_rows",
            f'Only {n} row{"" if n == 1 else "s"} have a value in "{target}"; we need at least {MIN_ROWS}.',
            "Use a larger file: every model is scored on rows it never saw, which needs a few dozen rows.",
            f"{n} labelled rows (< {MIN_ROWS})",
        )


_DATA_MESSAGES = {
    "download_failed": (
        "We couldn't download the file.",
        "Check that the link is public (anyone with the link can view) and points straight at the file, "
        "then retry.",
    ),
    "not_csv": (
        "That link didn't give us a table we can read.",
        "Use a direct link to a CSV or TSV file (on GitHub, the “Raw” button).",
    ),
    "file_not_found": ("The data file wasn't found.", "Upload it again."),
}


def classify(exc: BaseException) -> Failure:
    """The Failure for an exception that ended a run."""
    from autotinker.agent.llm import LLMError
    from autotinker.data.sources import DataSourceError

    if isinstance(exc, RunError):
        return exc.failure
    if isinstance(exc, DataSourceError):
        code = exc.code if exc.code in CODES else "not_csv"
        if code in _DATA_MESSAGES:
            msg, hint = _DATA_MESSAGES[code]
            return Failure(code, msg, hint, _short(str(exc)))
        return Failure("unexpected", "Something went wrong reading the data.", "", _short(str(exc)))
    if isinstance(exc, MemoryError):
        return Failure(
            "out_of_memory",
            "The run ran out of memory.",
            "Try a smaller file (fewer rows or columns).",
            "MemoryError",
        )
    cause: BaseException | None = exc
    for _ in range(8):  # an agent role wraps the provider error (RoleFailed from LLMError)
        if cause is None:
            break
        if isinstance(cause, LLMError):
            return llm_unavailable(str(cause))
        cause = cause.__cause__ or cause.__context__
    return Failure(
        "unexpected",
        "The run stopped on an unexpected error.",
        "Retry; if it fails again, the details below help us find the cause.",
        _short(f"{type(exc).__name__}: {exc}"),
    )


def llm_unavailable(detail: str) -> Failure:
    return Failure(
        "llm_unavailable",
        "The AI models that plan the experiments are unavailable right now.",
        "They are probably out of quota for the moment. Retry in a few minutes.",
        _short(detail),
    )
