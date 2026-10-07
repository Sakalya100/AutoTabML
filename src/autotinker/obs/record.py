"""RunRecord: the complete, replayable record of one run (written as run.json next to events.jsonl)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from autotinker.contracts import CVScore, DataProfile, Decision, Idea, LLMUsage, TaskSpec

RECORD_VERSION = 1


class ExperimentRecord(BaseModel):
    id: str  # "e000", "e001", ...
    parent_id: str | None
    idea: Idea
    code: str  # final solution.py for this experiment (after any repairs)
    diff: str = ""  # unified diff against the parent's code
    status: Decision
    reason: str = ""
    cv: CVScore | None = None
    select_score: float | None = None
    fit_time_s: float | None = None
    loc: int = 0
    repair_attempts: int = 0
    error_kind: str | None = None
    error_tail: str | None = None
    llm_calls: list[LLMUsage] = Field(default_factory=list)
    cost_usd: float = 0.0
    duration_s: float = 0.0
    started_at: str = ""


class FinalScores(BaseModel):
    best_exp_id: str
    dev_cv_mean: float
    select_score: float
    test_score: float
    optimism_gap: float


class RunRecord(BaseModel):
    version: int = RECORD_VERSION
    run_id: str
    created_at: str
    mode: str  # "run" (single draft + repair) or "evolve"
    proposer: str  # "llm:<model>" or "heuristic"
    task: TaskSpec
    profile: DataProfile
    config: dict[str, Any] = Field(default_factory=dict)
    experiments: list[ExperimentRecord] = Field(default_factory=list)
    best_exp_id: str | None = None
    stop: dict[str, Any] | None = None  # {"reason", "summary", "report"}
    final: FinalScores | None = None
    total_cost_usd: float = 0.0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    wall_time_s: float = 0.0
