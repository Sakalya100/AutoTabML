"""Event stream emitted during a run. The CLI, the SDK callback and the web app all consume these.

Wire format: one JSON object per line (JSONL), discriminated by `type`.
`schema/events.schema.json` is generated from these models (`python -m autotinker.obs.schema`).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, TypeAdapter

from autotinker.contracts import (
    AgentStep,
    CVScore,
    DataProfile,
    Decision,
    HpoTrial,
    Idea,
    LLMUsage,
    TaskSpec,
)


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
    phase: str | None = None  # agentic: baseline | draft | improve | tune | ensemble (None in legacy runs)


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
    reason: Literal[
        "ceiling", "max_experiments", "max_cost", "max_time", "user", "proposer_failure", "max_tokens"
    ]
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


# ---------------------------------------------------------------- agentic events (v3, additive)


class AgentStepStarted(_Base):
    type: Literal["agent_step_started"] = "agent_step_started"
    exp_id: str | None  # None for run-level steps (intake, profiler, reporter)
    step_id: str
    role: str
    attempt: int = 0
    input_summary: str = ""


class AgentReasoning(_Base):
    type: Literal["agent_reasoning"] = "agent_reasoning"
    exp_id: str | None
    step_id: str
    role: str
    text: str


class AgentStepFinished(_Base):
    type: Literal["agent_step_finished"] = "agent_step_finished"
    exp_id: str | None
    step: AgentStep


class SandboxLog(_Base):
    type: Literal["sandbox_log"] = "sandbox_log"
    exp_id: str
    attempt: int = 0
    stream: Literal["stdout", "stderr"] = "stdout"
    lines: list[str]  # throttled: at most a few dozen lines per event


class HpoTrialEvent(_Base):
    type: Literal["hpo_trial"] = "hpo_trial"
    exp_id: str
    trial: HpoTrial


class SteerApplied(_Base):
    """A steering message from the person watching was accepted: it is included in every later Planner and
    Tuner prompt, starting with experiment `at_exp`."""

    type: Literal["steer_applied"] = "steer_applied"
    text: str
    at_exp: str | None = None


class ReportReady(_Base):
    type: Literal["report_ready"] = "report_ready"
    report: dict[str, Any]


# ---------------------------------------------------------------- run assets (charts + downloads)


class CurveSeries(BaseModel):
    name: str  # legend label, e.g. "AUC 0.873"
    points: list[list[float]]  # [x, y] pairs, at most 200 per series


class CurveChart(BaseModel):
    """ROC / precision-recall style line chart."""

    id: str  # "roc" | "pr"
    title: str
    kind: Literal["curve"] = "curve"
    x_label: str
    y_label: str
    series: list[CurveSeries]
    diagonal: bool = False  # draw the y = x reference line
    note: str | None = None


class MatrixChart(BaseModel):
    """Confusion matrix: rows = actual, columns = predicted, both in `labels` order."""

    id: str  # "confusion"
    title: str
    kind: Literal["matrix"] = "matrix"
    labels: list[str]  # original (decoded) class labels
    matrix: list[list[int]]
    note: str | None = None


class ScatterChart(BaseModel):
    id: str  # "pred_vs_actual"
    title: str
    kind: Literal["scatter"] = "scatter"
    x_label: str
    y_label: str
    points: list[list[float]]  # [x, y] = [actual, predicted], at most 500, sampled deterministically
    diagonal: bool = False
    note: str | None = None


class HistogramBin(BaseModel):
    x0: float
    x1: float
    count: int


class HistogramChart(BaseModel):
    id: str  # "residuals"
    title: str
    kind: Literal["histogram"] = "histogram"
    x_label: str
    bins: list[HistogramBin]
    note: str | None = None


Chart = Annotated[CurveChart | MatrixChart | ScatterChart | HistogramChart, Field(discriminator="kind")]


class AssetFile(BaseModel):
    name: str  # "model.joblib"
    path: str  # relative to the run directory, e.g. "assets/model.joblib"
    bytes: int
    kind: Literal["model", "code"]
    content_type: str


class AssetsReady(_Base):
    """Charts computed on the locked test split, and the downloadable files written to `<run_dir>/assets/`.
    Emitted after `run_finished` and before `report_ready`."""

    type: Literal["assets_ready"] = "assets_ready"
    charts: list[Chart] = Field(default_factory=list)
    files: list[AssetFile] = Field(default_factory=list)


Event = Annotated[
    RunStarted
    | ExperimentStarted
    | LLMCall
    | SandboxFinished
    | ExperimentScored
    | DecisionMade
    | Stopped
    | RunFinished
    | AgentStepStarted
    | AgentReasoning
    | AgentStepFinished
    | SandboxLog
    | HpoTrialEvent
    | ReportReady
    | SteerApplied
    | AssetsReady,
    Field(discriminator="type"),
]

EventAdapter: TypeAdapter[Event] = TypeAdapter(Event)


def parse_event(line: str) -> Event:
    return EventAdapter.validate_json(line)
