"""Metric computation. Runs in the trusted parent process only, never next to solution code.

All scores returned here are *oriented* (higher is better), see `contracts.Metric.to_oriented`.
"""

from __future__ import annotations

import math

import numpy as np
from numpy.typing import NDArray
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    log_loss,
    mean_absolute_error,
    r2_score,
    roc_auc_score,
    root_mean_squared_error,
)

from autotinker.contracts import CVScore, Metric, ProblemType

PROBA_METRICS = frozenset({Metric.roc_auc, Metric.log_loss})


class InvalidOutput(ValueError):
    """Predictions that cannot be scored: wrong shape, NaN/inf, labels out of range."""


def needs_proba(metric: Metric) -> bool:
    return metric in PROBA_METRICS


def validate_predictions(
    pred: NDArray[np.float64], n_rows: int, metric: Metric, ptype: ProblemType, n_classes: int
) -> NDArray[np.float64]:
    """Check the shape and values of a prediction array; raise InvalidOutput with a helpful message."""
    arr = np.asarray(pred, dtype=float)
    if needs_proba(metric):
        if arr.shape != (n_rows, n_classes):
            raise InvalidOutput(
                f"predict_proba output has shape {arr.shape}, expected ({n_rows}, {n_classes})"
            )
    elif arr.shape != (n_rows,):
        raise InvalidOutput(f"predict output has shape {arr.shape}, expected ({n_rows},)")
    if not np.all(np.isfinite(arr)):
        raise InvalidOutput("predictions contain NaN or inf")
    if needs_proba(metric):
        if np.any(arr < -1e-9) or np.any(arr > 1 + 1e-9):
            raise InvalidOutput("predicted probabilities fall outside [0, 1]")
        sums = arr.sum(axis=1)
        if np.any(np.abs(sums - 1.0) > 1e-3):
            raise InvalidOutput("predicted probabilities do not sum to 1 for every row")
    elif ptype != ProblemType.regression:
        valid = (arr == np.round(arr)) & (arr >= 0) & (arr < n_classes)
        if not np.all(valid):
            raise InvalidOutput(
                f"predicted labels must be integers in 0..{n_classes - 1} (the encoded classes)"
            )
    return arr


def score(
    metric: Metric, ptype: ProblemType, y_true: NDArray[np.float64], pred: NDArray[np.float64], n_classes: int
) -> float:
    """Oriented score of validated predictions `pred` against `y_true` (encoded labels or numeric target)."""
    arr = validate_predictions(pred, len(y_true), metric, ptype, n_classes)
    raw: float
    if metric == Metric.roc_auc:
        if len(np.unique(y_true)) < 2:
            raise InvalidOutput("roc_auc is undefined on a split with a single class")
        raw = float(roc_auc_score(y_true, arr[:, 1]))
    elif metric == Metric.log_loss:
        clipped = np.clip(arr, 1e-15, 1 - 1e-15)
        clipped = clipped / clipped.sum(axis=1, keepdims=True)
        raw = float(log_loss(y_true, clipped, labels=list(range(n_classes))))
    elif metric == Metric.accuracy:
        raw = float(accuracy_score(y_true, arr.astype(int)))
    elif metric == Metric.f1_macro:
        raw = float(f1_score(y_true, arr.astype(int), average="macro", labels=list(range(n_classes))))
    elif metric == Metric.rmse:
        raw = float(root_mean_squared_error(y_true, arr))
    elif metric == Metric.mae:
        raw = float(mean_absolute_error(y_true, arr))
    elif metric == Metric.r2:
        raw = float(r2_score(y_true, arr))
    else:  # pragma: no cover - exhaustive over Metric
        raise ValueError(f"unknown metric {metric}")
    if not math.isfinite(raw):
        raise InvalidOutput(f"{metric.value} evaluated to a non-finite value")
    return metric.to_oriented(raw)


def cv_score(folds: list[float]) -> CVScore:
    """Aggregate per-fold oriented scores. se = std(ddof=1) / sqrt(n) (0.0 for a single fold)."""
    if not folds:
        raise ValueError("no fold scores")
    arr = np.asarray(folds, dtype=float)
    se = float(arr.std(ddof=1) / math.sqrt(len(arr))) if len(arr) > 1 else 0.0
    return CVScore(mean=float(arr.mean()), se=se, folds=[float(f) for f in arr])
