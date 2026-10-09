"""The runner interface: where an engine run executes (a local process, or a Vercel Sandbox)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from autotinker_api import settings

ControlCommand = dict[str, str]  # {"type": "steer", "text": ...} | {"type": "stop"}


@dataclass(frozen=True)
class StartRequest:
    run: dict[str, Any]
    csv: bytes | None
    ingest_url: str
    ingest_token: str


class Runner(Protocol):
    kind: Literal["local", "sandbox"]

    async def start(self, req: StartRequest) -> None:
        """Launch the run. May take a while (sandbox create + install); callers run it in the background. Failures
        are recorded on the run row, not raised."""

    async def control(self, run: dict[str, Any], cmd: ControlCommand) -> bool:
        """Deliver a steer/stop to the running engine (appended to its control file). False if unreachable."""

    async def cancel(self, run: dict[str, Any]) -> bool:
        """Stop the run now (no locked test, no report). False if there was nothing to stop."""


def engine_args(
    *,
    source: str,
    target: str,
    max_experiments: int,
    out_dir: str,
    control_file: str,
    metric: str | None = None,
    goal: str | None = None,
    max_time_s: int | None = None,
    csv_format: dict[str, Any] | None = None,
) -> list[str]:
    """`autotinker run` arguments (after `python -m autotinker`), shared by both runners. argv, never a shell string.
    `csv_format` ({delimiter, encoding, decimal} from the preview / upload check) becomes --delimiter / --encoding /
    --decimal, so the engine parses the file the way the preview did; whatever is missing the engine detects."""
    args = ["run", source, "--target", target]
    if metric:
        args += ["--metric", metric]
    # AUTOTINKER_PASS_CSV_FORMAT=0 is the escape hatch for an engine that predates the flags (it then detects).
    fmt = (csv_format or {}) if settings.env("AUTOTINKER_PASS_CSV_FORMAT") != "0" else {}
    for key in ("delimiter", "encoding", "decimal"):
        v = fmt.get(key)
        if isinstance(v, str) and v:
            args += [f"--{key}", "tab" if v == "\t" else v]
    if goal and settings.env("AUTOTINKER_PASS_DESCRIPTION") != "0":
        args += ["--goal", goal]
    args += ["--max-experiments", str(max_experiments), "--out", out_dir, "--events-stdout"]
    args += ["--control-file", control_file]
    if max_time_s:
        args += ["--max-time", str(max_time_s)]
    return args


def exit_status(
    *, code: int | None, cancelled: bool, has_record: bool, spawn_error: str | None = None
) -> tuple[str, str | None]:
    """The run's final (status, error) from how the engine process ended."""
    # A cancel that raced the engine's own clean exit (locked test + report already written) doesn't undo the run.
    if cancelled and not (code == 0 and has_record):
        return "cancelled", "Cancelled by user."
    if spawn_error:
        return (
            "failed",
            f"Could not start the engine ({spawn_error}). Is uv installed and AUTOTINKER_PYTHON_CMD correct?",
        )
    if code == 0:
        return "finished", None
    # Exit 3 = the agents gave up early (proposer_failure). The engine still scored the locked test and reported.
    if code == 3 and has_record:
        return (
            "finished",
            "The agents stopped early after repeated failures; the best model so far was scored on the locked test.",
        )
    return "failed", f"The engine exited with code {code}." if code is not None else "The engine was killed."
