"""Runner selection: AUTOTINKER_RUNNER=local|sandbox (default: sandbox on Vercel, local elsewhere)."""

from __future__ import annotations

from autotinker_api.runners.base import Runner

_override: dict[str, Runner] = {}


def get_runner(kind: str) -> Runner:
    """The runner for a run's `runner` column (each run keeps the runner it started on)."""
    if kind in _override:
        return _override[kind]
    if kind == "sandbox":
        from autotinker_api.runners.sandbox import SandboxRunner

        return SandboxRunner()
    from autotinker_api.runners.local import LocalRunner

    return LocalRunner()


def set_runner_for_tests(kind: str, runner: Runner | None) -> None:
    if runner is None:
        _override.pop(kind, None)
    else:
        _override[kind] = runner
