"""Shared data contracts between the harness, the agent, the evolve loop and the web app.

Score convention: every score stored in these models is *oriented* so that higher is better.
Metrics that are minimised (rmse, log_loss) are stored negated; use `Metric.to_raw` for display.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

# ---------------------------------------------------------------- task


class ProblemType(str, Enum):
    binary = "binary"
    multiclass = "multiclass"
    regression = "regression"


class Metric(str, Enum):
    roc_auc = "roc_auc"
    log_loss = "log_loss"
    accuracy = "accuracy"
    f1_macro = "f1_macro"
    rmse = "rmse"
    mae = "mae"
    r2 = "r2"

    @property
    def greater_is_better(self) -> bool:
        return self not in (Metric.log_loss, Metric.rmse, Metric.mae)

    def to_raw(self, oriented: float) -> float:
        return oriented if self.greater_is_better else -oriented

    def to_oriented(self, raw: float) -> float:
        return raw if self.greater_is_better else -raw


class TaskSpec(BaseModel):
    target: str
    problem_type: ProblemType | None = None  # None = infer from the target column
    metric: Metric | None = None  # None = default for the problem type
    description: str = ""  # the user's own words about the problem
    seed: int = 0
    cv_folds: int = 5
    cv_repeats: int = 2
    select_frac: float = 0.15
    test_frac: float = 0.15
    experiment_timeout_s: float = 120.0
    experiment_memory_mb: int = 2048


# ---------------------------------------------------------------- profile


class ColumnKind(str, Enum):
    numeric = "numeric"
    categorical = "categorical"
    boolean = "boolean"
    datetime = "datetime"
    text = "text"
    id = "id"
    constant = "constant"


class ColumnProfile(BaseModel):
    name: str
    dtype: str
    kind: ColumnKind
    missing_frac: float
    n_unique: int
    examples: list[Any] = Field(default_factory=list)
    stats: dict[str, float] | None = None  # numeric: min, max, mean, std, q25, q50, q75, skew
    top_values: dict[str, int] | None = None  # categorical: most frequent values and counts
    flags: list[str] = Field(default_factory=list)  # e.g. "id_like", "possible_target_leak"


class DataProfile(BaseModel):
    n_rows: int
    n_cols: int
    target: str
    problem_type: ProblemType
    metric: Metric
    columns: list[ColumnProfile]  # feature columns only, target excluded
    target_summary: dict[str, Any]  # class counts, or numeric stats
    warnings: list[str] = Field(default_factory=list)
    sample_rows: list[dict[str, Any]] = Field(default_factory=list)  # at most 5


# ---------------------------------------------------------------- evaluation


class CVScore(BaseModel):
    mean: float  # oriented
    se: float  # standard error of the mean across folds
    folds: list[float]  # oriented, one per (repeat, fold), same order across experiments


class ExecResult(BaseModel):
    ok: bool
    cv: CVScore | None = None  # repeated k-fold on the dev split
    select_score: float | None = None  # oriented; fit on all of dev, scored on the select split
    fit_time_s: float | None = None
    duration_s: float = 0.0
    error_kind: Literal["static_check", "timeout", "memory", "runtime", "invalid_output"] | None = None
    error_tail: str | None = None  # last ~50 lines of stderr / traceback, what the agent gets to see
    stdout_tail: str | None = None
    static_warnings: list[str] = Field(default_factory=list)


class HarnessProtocol(Protocol):
    """Read-only to the agent. Owns the data, splits, sandbox and scoring."""

    profile: DataProfile

    def evaluate(self, code: str, exp_id: str) -> ExecResult: ...

    def score_test(self, code: str) -> float:
        """Score on the locked test split. Allowed exactly once per harness; raises on a second call."""
        ...


# ---------------------------------------------------------------- agent


class IdeaCategory(str, Enum):
    baseline = "baseline"
    preprocessing = "preprocessing"
    feature_engineering = "feature_engineering"
    model_family = "model_family"
    hyperparameters = "hyperparameters"
    ensembling = "ensembling"
    simplification = "simplification"
    repair = "repair"


class Idea(BaseModel):
    title: str  # one line, stated before any code is written
    rationale: str = ""
    category: IdeaCategory
    radical: bool = False  # a different model family / approach, used by the stop rule


LLMPurpose = Literal[
    "draft",
    "propose",
    "implement",
    "repair",
    # agentic roles (v3)
    "intake",
    "profiler",
    "planner",
    "coder",
    "debugger",
    "critic",
    "judge",
    "tuner",
    "ensembler",
    "reporter",
]


class LLMUsage(BaseModel):
    purpose: LLMPurpose
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    latency_s: float = 0.0


class Decision(str, Enum):
    keep = "keep"
    discard = "discard"
    crash = "crash"


# ---------------------------------------------------------------- agentic steps (v3, additive)


class AgentStep(BaseModel):
    """One step of one agent (or of a deterministic actor such as the executor) inside an experiment.

    LLM steps carry the model/provider and token accounting; executor/ablation/tune steps carry the sandbox
    tails. `plain` is the one-line, plain-language message shown in the chat."""

    step_id: str = ""
    role: str  # intake | profiler | planner | coder | executor | debugger | critic | judge | tuner | ...
    model: str | None = None
    provider: str | None = None
    attempt: int = 0
    status: Literal["ok", "error"] = "ok"
    plain: str = ""
    input_summary: str = ""
    reasoning: str | None = None  # the model's parsed reasoning, when the provider returns it
    output: dict[str, Any] | None = None  # parsed structured output
    code: str | None = None
    diff: str | None = None
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    stdout_tail: str | None = None
    stderr_tail: str | None = None
    error: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    tokens_cached: int = 0
    cost_usd: float = 0.0  # actually billed (0 on free tiers)
    would_be_cost_usd: float = 0.0  # list price of the same tokens
    duration_s: float = 0.0
    started_at: str = ""


class HpoTrial(BaseModel):
    number: int
    params: dict[str, Any] = Field(default_factory=dict)
    value: float | None = None  # oriented inner-CV score; None when the trial failed
    state: Literal["complete", "fail", "pruned"] = "complete"
    duration_s: float = 0.0
