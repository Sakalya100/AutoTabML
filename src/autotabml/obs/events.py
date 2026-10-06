"""Event stream emitted during a run. The CLI, the SDK callback and the web app all consume these.

Wire format: one JSON object per line (JSONL), discriminated by `type`.
`schema/events.schema.json` is generated from these models (`python -m autotabml.obs.schema`).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, TypeAdapter

from autotabml.contracts import CVScore, DataProfile, Decision, Idea, LLMUsage, TaskSpec


def _now() -> str:
    return datetime.now(UTC).isoformat()


class _Base(BaseModel):
    run_id: str
    seq: int = 0  # assigned by the emitter, strictly increasing per run
    ts: str = Field(default_factory=_now)


class RunStarted(_Base):
    type: Literal["run_started"] = "run_started"
    task: TaskSpec
    profile: DataProfile
    config: dict[str, Any]  # mode, budgets, proposer label, model, etc.
    proposer: str  # "llm:<model>" or "heuristic" (offline, no LLM)


class ExperimentStarted(_Base):
    type: Literal["experiment_started"] = "experiment_started"
    exp_id: str
    parent_id: str | None
    idea: Idea


class LLMCall(_Base):
    type: Literal["llm_call"] = "llm_call"
    exp_id: str | None
    usage: LLMUsage


class SandboxFinished(_Base):
    type: Literal["sandbox_finished"] = "sandbox_finished"
    exp_id: str
    attempt: int  # 0 = first try, 1.. = repair attempts
    ok: bool
    duration_s: float
    error_kind: str | None = None
    error_tail: str | None = None


class ExperimentScored(_Base):
    type: Literal["experiment_scored"] = "experiment_scored"
    exp_id: str
    cv: CVScore
    select_score: float
    fit_time_s: float
    loc: int  # lines of code in solution.py, used by the simplicity rule


class DecisionMade(_Base):
    type: Literal["decision"] = "decision"
    exp_id: str
    decision: Decision
    reason: str
    best_exp_id: str
    best_cv_mean: float


class Stopped(_Base):
    type: Literal["stopped"] = "stopped"
    reason: Literal["ceiling", "max_experiments", "max_cost", "max_time", "user", "proposer_failure"]
    report: dict[str, Any]  # signal name -> {value, threshold, fired, detail}; see evolve/stopping.py
    summary: str  # human-readable explanation


class RunFinished(_Base):
    type: Literal["run_finished"] = "run_finished"
    best_exp_id: str
    dev_cv_mean: float
    select_score: float
    test_score: float  # locked holdout, scored exactly once
    optimism_gap: float  # select_score - test_score (oriented units)
    n_experiments: int
    total_cost_usd: float
    wall_time_s: float


Event = Annotated[
    RunStarted
    | ExperimentStarted
    | LLMCall
    | SandboxFinished
    | ExperimentScored
    | DecisionMade
    | Stopped
    | RunFinished,
    Field(discriminator="type"),
]

EventAdapter: TypeAdapter[Event] = TypeAdapter(Event)


def parse_event(line: str) -> Event:
    return EventAdapter.validate_json(line)
