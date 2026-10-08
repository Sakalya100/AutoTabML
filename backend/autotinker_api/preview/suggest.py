"""Deterministic suggestions for a new run: the column to predict, the problem type and the metric.

A port of web/src/lib/ingest/suggest.ts (the browser recomputes a suggestion with it when the user picks another
target). The problem-type rule mirrors `infer_problem_type` in the engine's data/profiler.py, and the metric defaults
and valid sets mirror DEFAULT_METRIC / _VALID_METRICS there; the engine is not imported because the backend is
deployed without pandas.
"""

from __future__ import annotations

import re
from typing import Any

from autotinker_api.preview.csvparse import ColumnStats

Suggestion = dict[str, Any]

PROBLEM_TYPES = ("binary", "multiclass", "regression")
DEFAULT_METRIC = {"binary": "roc_auc", "multiclass": "log_loss", "regression": "rmse"}
VALID_METRICS = {
    "binary": ("roc_auc", "log_loss", "accuracy", "f1_macro"),
    "multiclass": ("log_loss", "accuracy", "f1_macro"),
    "regression": ("rmse", "mae", "r2"),
}
_CLASSIFICATION_MAX_UNIQUE = 20
_CLASSIFICATION_MAX_RATIO = 0.05

_STRONG = {
    *"target label labels class y outcome survived churn churned exited attrition diagnosis".split(),
    *"price saleprice species variety quality default fraud isfraud income medv charges".split(),
    *"response result outcome_type deposit approved loan_status heartdisease disease stroke".split(),
    *"diabetes malignant category rating score salary sales revenue cost value medhouseval".split(),
}
_WEAK_TOKENS = re.compile(r"(target|label|class|outcome|churn|surviv|diagnos|price|default|fraud|status|result|grade)")
_METRIC_WHY = {
    "binary": "ROC-AUC ranks yes/no predictions fairly even when one outcome is rare",
    "multiclass": "log-loss rewards confident, correct class probabilities",
    "regression": "RMSE is in the target's own units",
}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def _words(s: str) -> list[str]:
    return [w for w in re.split(r"[^a-z0-9]+", s.lower()) if len(w) > 2]


def metric_fits(ptype: str, metric: str) -> bool:
    return metric in VALID_METRICS.get(ptype, ())


def infer_problem_type(c: ColumnStats, n_rows: int) -> str | None:
    if c["unique"] < 2 or c["kind"] == "empty":
        return None
    if c["kind"] == "numeric":
        return "regression"
    if c["kind"] in ("integer", "id"):
        if c["unique"] == 2:
            return "binary"
        if c["unique"] <= _CLASSIFICATION_MAX_UNIQUE and c["unique"] / max(n_rows, 1) <= _CLASSIFICATION_MAX_RATIO:
            return "multiclass"
        return "regression"
    if c["kind"] == "boolean":
        return "binary"
    return "binary" if c["unique"] == 2 else "multiclass"


def _n_rows(stats: list[ColumnStats]) -> int:
    return max([int(s["count"]) + int(s["missing"]) for s in stats] + [1])


def score_targets(stats: list[ColumnStats], goal: str = "") -> list[dict[str, Any]]:
    goal_words = set(_words(goal))
    goal_norm = _norm(goal)
    n_rows = _n_rows(stats)
    out = []
    for i, c in enumerate(stats):
        score, why = 0, ""
        n = _norm(c["name"])
        cw = _words(c["name"])
        named = (
            goal
            and len(n) >= 2
            and (
                n in goal_norm
                or (
                    len(cw) > 0
                    and all(
                        w in goal_words or (w + "s") in goal_words or re.sub(r"s$", "", w) in goal_words for w in cw
                    )
                )
            )
        )
        if named:
            score += 20
            why = "named in your sentence"
        if n in _STRONG:
            score += 10
            why = why or "named like a prediction target"
        elif _WEAK_TOKENS.search(c["name"].lower()):
            score += 6
            why = why or "named like a prediction target"
        if i == len(stats) - 1:
            score += 3
            why = why or "the last column, where targets usually sit"
        if i == 0:
            score -= 2
        kind = c["kind"]
        if kind == "id":
            score -= 20
        if kind in ("datetime", "empty"):
            score -= 12
        if kind == "text":
            score -= 6
        if kind == "categorical" and c["unique"] > 50:
            score -= 4
        if 2 <= c["unique"] <= 20:
            score += 1
        if c["missing"] > 0.3 * n_rows:
            score -= 3
        if infer_problem_type(c, n_rows) is None:
            score -= 30
        out.append({"name": c["name"], "score": score, "why": why or "the most plausible column left"})
    return out


def _goal_sentence(target: str, ptype: str, c: ColumnStats | None) -> str:
    if ptype == "binary":
        return f"Predict {target} (one of two outcomes) for each row."
    if ptype == "multiclass":
        return f"Predict which {target} each row belongs to{f' ({c["unique"]} classes)' if c else ''}."
    return f"Predict the value of {target} for each row."


def suggestion_for(stats: list[ColumnStats], target: str, why: str, ambiguous: bool = False) -> Suggestion:
    c = next((s for s in stats if s["name"] == target), None)
    ptype = (infer_problem_type(c, _n_rows(stats)) if c else None) or "regression"
    return {
        "target": target,
        "problemType": ptype,
        "metric": DEFAULT_METRIC[ptype],
        "goalPlain": _goal_sentence(target, ptype, c),
        "why": f"{target}: {why}; {_METRIC_WHY[ptype]}.",
        "source": "heuristic",
        "ambiguous": ambiguous,
    }


def suggest(stats: list[ColumnStats], goal: str = "") -> Suggestion | None:
    """The most likely target column, with its problem type and metric. None if nothing can be a target."""
    if len(stats) < 2:
        return None
    ranked = sorted(score_targets(stats, goal), key=lambda r: -r["score"])  # stable, like Array.sort
    top = ranked[0]
    second = ranked[1] if len(ranked) > 1 else None
    if top["score"] < -10:
        return None
    ambiguous = top["score"] < 6 or (second is not None and top["score"] - second["score"] <= 2)
    return suggestion_for(stats, top["name"], top["why"], ambiguous)
