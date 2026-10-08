"""Run assets: charts computed on the locked test split, and the downloadable files of the final model.

Written after the single locked-test run (see `Harness.score_test`, which leaves `TestOutputs` behind):
  * `<run_dir>/assets/model.joblib`  the estimator fitted on dev+select, exactly as scored on the test split
  * `<run_dir>/assets/pipeline.py`   the final solution source (`build_pipeline(profile)`)
and announced by one `assets_ready` event. Assets are best-effort: any failure is logged as a warning and
never fails the run.

Loading the model: `joblib.load("model.joblib")` needs the same scikit-learn version; when the solution
defines its own estimator classes, run it from the assets directory so `pipeline.py` is importable (the
worker imports the solution under the module name `pipeline`). For classification the model predicts the
encoded labels 0..k-1, where label i is the i-th class in sorted order (the confusion matrix labels).
"""

from __future__ import annotations

import logging
import shutil
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import ArrayLike, NDArray
from sklearn.metrics import (
    auc,
    average_precision_score,
    confusion_matrix,
    precision_recall_curve,
    roc_auc_score,
    roc_curve,
)

from autotinker.obs.events import (
    AssetFile,
    AssetsReady,
    Chart,
    CurveChart,
    CurveSeries,
    HistogramBin,
    HistogramChart,
    MatrixChart,
    ScatterChart,
)

log = logging.getLogger(__name__)

MAX_CURVE_POINTS = 200
MAX_SCATTER_POINTS = 500
MAX_ROC_CLASSES = 10  # more classes -> one macro-average ROC series
MAX_MATRIX_CLASSES = 20  # more classes -> no confusion matrix
HIST_BINS = 30
MAX_EVENT_BYTES = 64 * 1024

ASSETS_DIR = "assets"
MODEL_FILE = "model.joblib"
CODE_FILE = "pipeline.py"


def _r(x: float, digits: int = 4) -> float:
    """Round to `digits` significant digits (keeps the event small)."""
    return float(f"{float(x):.{digits}g}")


def downsample(xs: ArrayLike, ys: ArrayLike, max_points: int) -> list[list[float]]:
    """Evenly spaced subset of a curve, at most `max_points`, always keeping both endpoints."""
    xs, ys = np.asarray(xs, dtype=float), np.asarray(ys, dtype=float)
    n = len(xs)
    if n == 0:
        return []
    if n <= max_points:
        idx = np.arange(n)
    else:
        idx = np.unique(np.linspace(0, n - 1, max(max_points, 2)).round().astype(int))
    return [[_r(xs[i]), _r(ys[i])] for i in idx]


# ---------------------------------------------------------------- classification


def _roc_chart(y: NDArray[Any], proba: NDArray[Any], labels: list[str], max_points: int) -> CurveChart | None:
    k = proba.shape[1]
    if k == 2:
        if len(np.unique(y)) < 2:
            return None
        fpr, tpr, _ = roc_curve(y, proba[:, 1])
        score = roc_auc_score(y, proba[:, 1])
        return CurveChart(
            id="roc",
            title="ROC curve",
            x_label="False positive rate",
            y_label="True positive rate",
            series=[CurveSeries(name=f"AUC {score:.3f}", points=downsample(fpr, tpr, max_points))],
            diagonal=True,
            note=f"positive class: {labels[1]}",
        )
    per_class: list[tuple[str, NDArray[Any], NDArray[Any], float]] = []
    for c in range(k):
        yc = (y == c).astype(int)
        if 0 < yc.sum() < len(yc):  # a class absent from the test split has no ROC curve
            fpr, tpr, _ = roc_curve(yc, proba[:, c])
            per_class.append((labels[c], fpr, tpr, float(auc(fpr, tpr))))
    if not per_class:
        return None
    note = "one-vs-rest"
    if len(per_class) < k:
        note += f"; {k - len(per_class)} class(es) absent from the test split are omitted"
    if k <= MAX_ROC_CLASSES:
        series = [
            CurveSeries(name=f"{name} · AUC {a:.3f}", points=downsample(fpr, tpr, max_points))
            for name, fpr, tpr, a in per_class
        ]
    else:
        grid = np.unique(np.concatenate([fpr for _, fpr, _, _ in per_class]))
        mean_tpr = np.mean([np.interp(grid, fpr, tpr) for _, fpr, tpr, _ in per_class], axis=0)
        series = [
            CurveSeries(
                name=f"macro AUC {float(auc(grid, mean_tpr)):.3f}",
                points=downsample(grid, mean_tpr, max_points),
            )
        ]
        note += f"; macro average over {len(per_class)} classes"
    return CurveChart(
        id="roc",
        title="ROC curve",
        x_label="False positive rate",
        y_label="True positive rate",
        series=series,
        diagonal=True,
        note=note,
    )


def _pr_chart(y: NDArray[Any], proba: NDArray[Any], labels: list[str], max_points: int) -> CurveChart | None:
    if proba.shape[1] != 2 or len(np.unique(y)) < 2:
        return None
    precision, recall, _ = precision_recall_curve(y, proba[:, 1])
    ap = average_precision_score(y, proba[:, 1])
    # sklearn returns recall decreasing; plot left to right
    return CurveChart(
        id="pr",
        title="Precision–recall curve",
        x_label="Recall",
        y_label="Precision",
        series=[
            CurveSeries(name=f"AP {ap:.2f}", points=downsample(recall[::-1], precision[::-1], max_points))
        ],
        diagonal=False,
        note=f"positive class: {labels[1]}; base rate {float(np.mean(y == 1)):.3f}",
    )


def _confusion_chart(y: NDArray[Any], yhat: NDArray[Any], labels: list[str], note: str) -> MatrixChart | None:
    k = len(labels)
    if k > MAX_MATRIX_CLASSES:
        return None
    m = confusion_matrix(y, yhat, labels=list(range(k)))
    return MatrixChart(
        id="confusion",
        title="Confusion matrix",
        labels=labels,
        matrix=[[int(v) for v in row] for row in m],
        note=note,
    )


def classification_charts(
    y_true: NDArray[Any],
    pred: NDArray[Any],
    proba: NDArray[Any] | None,
    classes: Sequence[Any],
    *,
    max_points: int = MAX_CURVE_POINTS,
) -> list[Chart]:
    """ROC (+ precision-recall for binary) from probabilities when available, and the confusion matrix.
    `y_true` holds encoded labels 0..k-1; `pred` is either probabilities (n, k) or encoded labels (n,)."""
    labels = [str(c) for c in classes]
    k = len(labels)
    y = np.asarray(y_true).astype(int)
    if proba is not None:
        proba = np.asarray(proba, dtype=float)
        if proba.ndim != 2 or proba.shape != (len(y), k) or not np.all(np.isfinite(proba)):
            proba = None
    charts: list[Chart] = []
    if proba is not None:
        for build in (_roc_chart, _pr_chart):
            chart = build(y, proba, labels, max_points)
            if chart is not None:
                charts.append(chart)
        if k == 2:
            yhat, note = (
                (proba[:, 1] >= 0.5).astype(int),
                "rows = actual, columns = predicted (threshold 0.5)",
            )
        else:
            yhat, note = proba.argmax(axis=1), "rows = actual, columns = predicted (most likely class)"
    else:
        arr = np.asarray(pred)
        yhat = arr.argmax(axis=1) if arr.ndim == 2 else arr.astype(int)
        note = "rows = actual, columns = predicted"
    matrix = _confusion_chart(y, yhat, labels, note)
    if matrix is not None:
        charts.append(matrix)
    return charts


# ---------------------------------------------------------------- regression


def regression_charts(y_true: NDArray[Any], pred: NDArray[Any]) -> list[Chart]:
    """Predicted-vs-actual scatter (deterministic sample of at most 500 rows) and a residual histogram."""
    y = np.asarray(y_true, dtype=float)
    p = np.asarray(pred, dtype=float).reshape(-1)
    ok = np.isfinite(y) & np.isfinite(p)
    y, p = y[ok], p[ok]
    n = len(y)
    if n == 0:
        return []
    if n > MAX_SCATTER_POINTS:
        idx = np.sort(np.random.default_rng(0).choice(n, MAX_SCATTER_POINTS, replace=False))
        note = f"{MAX_SCATTER_POINTS} of {n} test rows (fixed random sample)"
    else:
        idx, note = np.arange(n), f"all {n} test rows"
    scatter = ScatterChart(
        id="pred_vs_actual",
        title="Predicted vs actual",
        x_label="Actual",
        y_label="Predicted",
        points=[[_r(y[i], 5), _r(p[i], 5)] for i in idx],
        diagonal=True,
        note=note,
    )
    resid = y - p
    n_bins = HIST_BINS if n >= 4 * HIST_BINS else max(5, int(np.ceil(np.sqrt(n))))
    counts, edges = np.histogram(resid, bins=n_bins)
    hist = HistogramChart(
        id="residuals",
        title="Residuals",
        x_label="Actual − predicted",
        bins=[
            HistogramBin(x0=_r(edges[i], 5), x1=_r(edges[i + 1], 5), count=int(c))
            for i, c in enumerate(counts)
        ],
        note=f"mean {_r(float(resid.mean()))}, std {_r(float(resid.std()))}",
    )
    return [scatter, hist]


def build_charts(outputs: Any, *, max_points: int = MAX_CURVE_POINTS) -> list[Chart]:
    """Charts for a `harness.core.TestOutputs` (duck-typed: the obs package does not import the harness)."""
    if outputs.problem_type == "regression":
        return regression_charts(outputs.y_true, outputs.pred)
    if not outputs.classes:
        return []
    return classification_charts(
        outputs.y_true, outputs.pred, outputs.proba, outputs.classes, max_points=max_points
    )


# ---------------------------------------------------------------- files + event


def write_files(run_dir: Path, code: str, model_path: Path | None) -> list[AssetFile]:
    """Copy the fitted model and write the solution source into `<run_dir>/assets/`. Each file is
    independent: one that fails is logged and left out."""
    out = run_dir / ASSETS_DIR
    out.mkdir(parents=True, exist_ok=True)
    files: list[AssetFile] = []
    if model_path is not None:
        try:
            dest = out / MODEL_FILE
            shutil.copyfile(model_path, dest)
            files.append(
                AssetFile(
                    name=MODEL_FILE,
                    path=f"{ASSETS_DIR}/{MODEL_FILE}",
                    bytes=dest.stat().st_size,
                    kind="model",
                    content_type="application/octet-stream",
                )
            )
        except OSError as e:
            log.warning("run assets: could not copy the fitted model: %s", e)
    try:
        dest = out / CODE_FILE
        dest.write_text(code, encoding="utf-8")
        files.append(
            AssetFile(
                name=CODE_FILE,
                path=f"{ASSETS_DIR}/{CODE_FILE}",
                bytes=dest.stat().st_size,
                kind="code",
                content_type="text/x-python",
            )
        )
    except OSError as e:
        log.warning("run assets: could not write the solution source: %s", e)
    return files


def build_assets_event(run_id: str, run_dir: Path | None, code: str, outputs: Any | None) -> AssetsReady:
    """Write the asset files and build the `assets_ready` event, shrinking curves until it fits in 64 KB."""
    files: list[AssetFile] = []
    if run_dir is not None:
        model = outputs.model_path if outputs is not None else None
        if outputs is not None and model is None and outputs.model_error:
            log.warning("run assets: the fitted model could not be saved: %s", outputs.model_error)
        files = write_files(run_dir, code, model)
    charts: list[Chart] = []
    if outputs is not None:
        try:
            charts = build_charts(outputs)
        except Exception as e:  # noqa: BLE001 - charts are optional
            log.warning("run assets: chart computation failed: %s: %s", type(e).__name__, e)
    ev = AssetsReady(run_id=run_id, charts=charts, files=files)
    for max_points in (100, 50, 20):
        if len(ev.model_dump_json()) <= MAX_EVENT_BYTES - 1024:  # headroom for the emitter's seq/ts
            return ev
        ev = ev.model_copy(update={"charts": build_charts(outputs, max_points=max_points)})
    if len(ev.model_dump_json()) > MAX_EVENT_BYTES - 1024:
        ev = ev.model_copy(update={"charts": [c for c in ev.charts if c.kind == "matrix"]})
    return ev
