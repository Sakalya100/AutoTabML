"""Structured outputs of every agent role. Every output carries `plain`: one plain-language sentence for the
chat. Field defaults are lenient so small models are not rejected for an omitted optional field."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from autotinker.contracts import IdeaCategory


class _Out(BaseModel):
    plain: str = Field(default="", description="one plain-language sentence for a non-expert")


class IntakeOut(_Out):
    target: str
    problem_type: Literal["binary", "multiclass", "regression"]
    metric: Literal["roc_auc", "log_loss", "accuracy", "f1_macro", "rmse", "mae", "r2"]
    goal: str = ""
    warnings: list[str] = Field(default_factory=list)


class ProfilerOut(_Out):
    story: str = ""
    risks: list[str] = Field(default_factory=list)
    drop_columns: list[str] = Field(default_factory=list)  # ids / leaks the coder should not use
    split_advice: str = ""


FAMILIES = (
    "gradient_boosting",
    "random_forest",
    "extra_trees",
    "linear",
    "svm",
    "knn",
    "naive_bayes",
    "mlp",
    "ensemble",
    "other",
)


class PlanOut(_Out):
    title: str = Field(min_length=3)
    block: str = "model"  # which block of the pipeline the change targets
    rationale: str = ""
    category: IdeaCategory = IdeaCategory.model_family
    family: str = "other"  # model family of the resulting solution
    radical: bool = False

    @field_validator("category", mode="before")
    @classmethod
    def _cat(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip().lower().replace(" ", "_").replace("-", "_")
            if v in ("baseline", "repair"):
                return "model_family"
            if v not in {c.value for c in IdeaCategory}:
                return "model_family"
        return v

    @field_validator("family", mode="before")
    @classmethod
    def _fam(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip().lower().replace(" ", "_").replace("-", "_")
            return v if v in FAMILIES else "other"
        return "other"


class CodeOut(_Out):
    code: str = Field(min_length=20)


class CriticOut(_Out):
    verdict: Literal["valid", "suspicious", "leak"]
    reasons: str = ""
    learned: str = ""  # plain-language "what we learned" from this experiment

    @field_validator("verdict", mode="before")
    @classmethod
    def _v(cls, v: Any) -> Any:
        return v.strip().lower() if isinstance(v, str) else v


class ParamSpace(BaseModel):
    type: Literal["int", "float", "categorical"]
    low: float | None = None
    high: float | None = None
    log: bool = False
    choices: list[Any] | None = None


class TunerOut(_Out):
    params: dict[str, ParamSpace]  # sklearn set_params paths, e.g. "model__learning_rate"
    n_trials: int = 20
    rationale: str = ""

    @field_validator("params")
    @classmethod
    def _nonempty(cls, v: dict[str, ParamSpace]) -> dict[str, ParamSpace]:
        if not v:
            raise ValueError("params must name at least one hyperparameter")
        for name, sp in v.items():
            if "__" not in name and name.count(".") == 0 and not name.replace("_", "").isalnum():
                raise ValueError(f"bad parameter path {name!r}")
            if sp.type == "categorical" and not sp.choices:
                raise ValueError(f"{name}: categorical needs choices")
            if sp.type != "categorical" and (sp.low is None or sp.high is None or sp.low >= sp.high):
                raise ValueError(f"{name}: numeric needs low < high")
        return v


class EnsemblerOut(_Out):
    strategy: Literal["soft_vote", "stacking"] = "soft_vote"
    members: list[str] = Field(min_length=2)  # experiment ids
    weights: list[float] | None = None
    rationale: str = ""


class ReporterOut(_Out):
    summary: str
    what_worked: list[str] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)
    next_steps: list[str] = Field(default_factory=list)
    numbers: dict[str, float] = Field(default_factory=dict)  # every number quoted, by key from the facts
