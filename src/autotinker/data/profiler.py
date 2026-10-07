"""Code-generated dataset profile: the only view of the data the LLM ever gets.

Everything here is deterministic and computed by code, never by the LLM. The output must be fully
JSON-serialisable (no numpy scalars, no NaN), so every value goes through `jsonsafe`.
"""

from __future__ import annotations

import math
import re
import warnings
from datetime import date, datetime
from typing import Any

import numpy as np
import pandas as pd
from pandas.api import types as ptypes
from sklearn.metrics import normalized_mutual_info_score

from autotinker.contracts import ColumnKind, ColumnProfile, DataProfile, Metric, ProblemType, TaskSpec

MAX_EXAMPLES = 5
MAX_SAMPLE_ROWS = 5
MAX_TOP_VALUES = 10
HIGH_CARDINALITY = 50
MANY_MISSING = 0.30
LEAK_THRESHOLD = 0.98
TINY_DATASET = 100
IMBALANCE_RATIO = 10.0
CLASSIFICATION_MAX_UNIQUE = 20
CLASSIFICATION_MAX_RATIO = 0.05
TEXT_MEAN_LEN = 30
LEAK_SAMPLE = 20_000

DEFAULT_METRIC: dict[ProblemType, Metric] = {
    ProblemType.binary: Metric.roc_auc,
    ProblemType.multiclass: Metric.log_loss,
    ProblemType.regression: Metric.rmse,
}
_VALID_METRICS: dict[ProblemType, set[Metric]] = {
    ProblemType.binary: {Metric.roc_auc, Metric.log_loss, Metric.accuracy, Metric.f1_macro},
    ProblemType.multiclass: {Metric.log_loss, Metric.accuracy, Metric.f1_macro},
    ProblemType.regression: {Metric.rmse, Metric.mae, Metric.r2},
}

_ID_NAME = re.compile(r"(^|[_\s.\-])(id|uuid|guid)$|^(id|uuid|guid|index|idx|key|row_?id)([_\s.\-]|$)", re.I)
_CAMEL_ID = re.compile(r"[a-z0-9]Id$")
_DATE_LIKE = re.compile(r"\d{1,4}[-/.:]\d{1,2}")
_BOOL_TOKENS = {"yes", "no", "true", "false", "y", "n", "t", "f", "0", "1"}


# ---------------------------------------------------------------- JSON safety


def jsonsafe(value: Any) -> Any:
    """Convert a pandas/numpy scalar into a plain JSON-safe Python value (NaN/NA -> None)."""
    if value is None:
        return None
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, bool | int | str):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, pd.Timestamp | datetime | date):
        return value.isoformat()
    if isinstance(value, pd.Timedelta):
        return str(value)
    return str(value)


def _finite_stats(raw: dict[str, Any]) -> dict[str, float]:
    out: dict[str, float] = {}
    for k, v in raw.items():
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if math.isfinite(f):
            out[k] = f
    return out


# ---------------------------------------------------------------- problem type / metric


def _is_integer_like(s: pd.Series) -> bool:
    if ptypes.is_bool_dtype(s.dtype):
        return True
    if not ptypes.is_numeric_dtype(s.dtype):
        return False
    vals = s.dropna().to_numpy(dtype=float)
    return bool(vals.size) and bool(np.all(np.isfinite(vals))) and bool(np.all(vals == np.round(vals)))


def infer_problem_type(y: pd.Series) -> ProblemType:
    """Infer the problem type from a target column with missing values already removed."""
    n_unique = int(y.nunique(dropna=True))
    if n_unique < 2:
        raise ValueError(f"target '{y.name}' has fewer than 2 distinct values; nothing to learn")
    numeric = ptypes.is_numeric_dtype(y.dtype) and not ptypes.is_bool_dtype(y.dtype)
    if not numeric:
        return ProblemType.binary if n_unique == 2 else ProblemType.multiclass
    if _is_integer_like(y) and n_unique <= CLASSIFICATION_MAX_UNIQUE:
        ratio = n_unique / max(len(y), 1)
        if n_unique == 2 or ratio <= CLASSIFICATION_MAX_RATIO:
            return ProblemType.binary if n_unique == 2 else ProblemType.multiclass
    return ProblemType.regression


def resolve_task(df: pd.DataFrame, task: TaskSpec) -> TaskSpec:
    """Return a copy of `task` with problem_type and metric filled in and validated."""
    if task.target not in df.columns:
        raise ValueError(f"target column '{task.target}' not found; columns are {list(df.columns)}")
    y = df[task.target].dropna()
    ptype = task.problem_type or infer_problem_type(y)
    n_unique = int(y.nunique())
    if ptype == ProblemType.binary and n_unique != 2:
        raise ValueError(f"problem_type=binary but target has {n_unique} distinct values")
    if ptype == ProblemType.regression and not ptypes.is_numeric_dtype(y.dtype):
        raise ValueError("problem_type=regression but the target is not numeric")
    metric = task.metric or DEFAULT_METRIC[ptype]
    if metric not in _VALID_METRICS[ptype]:
        raise ValueError(f"metric '{metric.value}' is not valid for {ptype.value} problems")
    return task.model_copy(update={"problem_type": ptype, "metric": metric})


# ---------------------------------------------------------------- column kinds


def _looks_like_id_name(name: str) -> bool:
    return bool(_ID_NAME.search(name) or _CAMEL_ID.search(name))


def _is_textual(s: pd.Series) -> bool:
    return (
        ptypes.is_string_dtype(s.dtype)
        or ptypes.is_object_dtype(s.dtype)
        or isinstance(s.dtype, pd.CategoricalDtype)
    )


def _parses_as_datetime(nonnull: pd.Series) -> bool:
    sample = nonnull.astype(str).head(100)
    if sample.empty or not sample.str.contains(_DATE_LIKE).mean() >= 0.9:
        return False
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        parsed = pd.to_datetime(sample, errors="coerce", format="mixed")
    return bool(parsed.notna().mean() >= 0.9)


def infer_kind(s: pd.Series) -> ColumnKind:
    nonnull = s.dropna()
    n = len(nonnull)
    n_unique = int(nonnull.nunique())
    if n_unique <= 1:
        return ColumnKind.constant
    if ptypes.is_bool_dtype(s.dtype):
        return ColumnKind.boolean
    if ptypes.is_datetime64_any_dtype(s.dtype):
        return ColumnKind.datetime
    name = str(s.name)
    all_unique = n_unique == n and n >= 20
    if ptypes.is_numeric_dtype(s.dtype):
        if n_unique == 2 and set(nonnull.unique().tolist()) <= {0, 1}:
            return ColumnKind.boolean
        if all_unique and _is_integer_like(nonnull):
            vals = nonnull.to_numpy(dtype=float)
            is_row_index = float(vals.max() - vals.min()) + 1 == n_unique
            if _looks_like_id_name(name) or is_row_index:
                return ColumnKind.id
        return ColumnKind.numeric
    if _is_textual(s):
        as_str = nonnull.astype(str)
        if n_unique == 2 and set(as_str.str.strip().str.lower().unique()) <= _BOOL_TOKENS:
            return ColumnKind.boolean
        if _parses_as_datetime(nonnull):
            return ColumnKind.datetime
        mean_len = float(as_str.str.len().mean())
        has_spaces = float(as_str.str.contains(" ").mean()) > 0.5
        if mean_len > TEXT_MEAN_LEN and has_spaces and n_unique > 0.5 * n:
            return ColumnKind.text
        if all_unique or (_looks_like_id_name(name) and n_unique > 0.9 * n):
            return ColumnKind.id
        return ColumnKind.categorical
    return ColumnKind.categorical


# ---------------------------------------------------------------- leakage


def _discretise(s: pd.Series) -> pd.Series:
    """Map a series to integer codes; numeric columns with many values are binned into quantiles."""
    if ptypes.is_numeric_dtype(s.dtype) and not ptypes.is_bool_dtype(s.dtype) and s.nunique() > 50:
        return pd.Series(pd.qcut(s.rank(method="first"), q=20, labels=False), index=s.index)
    return pd.Series(pd.factorize(s.astype(str))[0], index=s.index)


def _leak_score(x: pd.Series, y: pd.Series) -> float:
    both = pd.concat([x, y], axis=1, keys=["x", "y"]).dropna()
    if len(both) < 10 or both["x"].nunique() < 2:
        return 0.0
    if len(both) > LEAK_SAMPLE:
        both = both.sample(LEAK_SAMPLE, random_state=0)
    score = 0.0
    xnum = ptypes.is_numeric_dtype(both["x"].dtype) and not ptypes.is_bool_dtype(both["x"].dtype)
    ynum = ptypes.is_numeric_dtype(both["y"].dtype) and not ptypes.is_bool_dtype(both["y"].dtype)
    if xnum and ynum:
        with np.errstate(all="ignore"):
            corr = float(np.corrcoef(both["x"].to_numpy(float), both["y"].to_numpy(float))[0, 1])
        if math.isfinite(corr):
            score = abs(corr)
    nmi = float(normalized_mutual_info_score(_discretise(both["y"]), _discretise(both["x"])))
    return max(score, nmi)


def _norm_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


# ---------------------------------------------------------------- column profile


def _profile_column(s: pd.Series, y: pd.Series, target: str) -> ColumnProfile:
    n = len(s)
    nonnull = s.dropna()
    kind = infer_kind(s)
    n_unique = int(nonnull.nunique())
    examples = [jsonsafe(v) for v in nonnull.drop_duplicates().head(MAX_EXAMPLES).tolist()]
    stats: dict[str, float] | None = None
    top_values: dict[str, int] | None = None
    numeric = ptypes.is_numeric_dtype(s.dtype) and not ptypes.is_bool_dtype(s.dtype)
    if numeric and kind in (ColumnKind.numeric, ColumnKind.boolean, ColumnKind.id) and len(nonnull):
        v = nonnull.astype(float)
        stats = _finite_stats(
            {
                "min": v.min(),
                "max": v.max(),
                "mean": v.mean(),
                "std": v.std(),
                "q25": v.quantile(0.25),
                "q50": v.quantile(0.5),
                "q75": v.quantile(0.75),
                "skew": v.skew() if n_unique > 2 else 0.0,
            }
        )
    if kind in (ColumnKind.categorical, ColumnKind.boolean, ColumnKind.constant) and len(nonnull):
        counts = nonnull.astype(str).value_counts().head(MAX_TOP_VALUES)
        top_values = {str(k): int(c) for k, c in counts.items()}

    flags: list[str] = []
    missing_frac = float(s.isna().mean()) if n else 0.0
    if kind == ColumnKind.id:
        flags.append("id_like")
    if kind == ColumnKind.constant:
        flags.append("constant")
    if kind == ColumnKind.categorical and n_unique > HIGH_CARDINALITY:
        flags.append("high_cardinality")
    if missing_frac > MANY_MISSING:
        flags.append("many_missing")
    tname = _norm_name(target)
    name_leak = len(tname) >= 3 and tname in _norm_name(str(s.name))
    if kind != ColumnKind.constant and (name_leak or _leak_score(s, y) > LEAK_THRESHOLD):
        flags.append("possible_target_leak")

    return ColumnProfile(
        name=str(s.name),
        dtype=str(s.dtype),
        kind=kind,
        missing_frac=round(missing_frac, 6),
        n_unique=n_unique,
        examples=examples,
        stats=stats,
        top_values=top_values,
        flags=flags,
    )


def _target_summary(y: pd.Series, ptype: ProblemType) -> dict[str, Any]:
    if ptype == ProblemType.regression:
        v = y.astype(float)
        return {
            "kind": "numeric",
            **_finite_stats(
                {
                    "min": v.min(),
                    "max": v.max(),
                    "mean": v.mean(),
                    "std": v.std(),
                    "q25": v.quantile(0.25),
                    "q50": v.quantile(0.5),
                    "q75": v.quantile(0.75),
                    "skew": v.skew(),
                }
            ),
        }
    counts = y.value_counts()
    return {
        "kind": "classes",
        "n_classes": int(len(counts)),
        "class_counts": {str(jsonsafe(k)): int(c) for k, c in counts.items()},
        "majority_frac": round(float(counts.iloc[0] / counts.sum()), 6),
    }


def _sample_rows(df: pd.DataFrame, seed: int) -> list[dict[str, Any]]:
    if df.empty:
        return []
    rows = df.sample(min(MAX_SAMPLE_ROWS, len(df)), random_state=seed)
    return [{str(k): jsonsafe(v) for k, v in row.items()} for _, row in rows.iterrows()]


def profile_dataframe(
    df: pd.DataFrame, task: TaskSpec, *, sample_from: pd.DataFrame | None = None
) -> DataProfile:
    """Profile `df` for `task`. Rows with a missing target are dropped (and a warning recorded).

    `sample_from` lets the harness restrict the example rows shown to the LLM to the dev split.
    """
    resolved = resolve_task(df, task)
    assert resolved.problem_type is not None and resolved.metric is not None
    ptype, metric = resolved.problem_type, resolved.metric
    target = task.target
    warn: list[str] = []

    missing_target = int(df[target].isna().sum())
    if missing_target:
        warn.append(f"{missing_target} rows with a missing target were dropped")
        df = df.loc[df[target].notna()]
    y = df[target]
    n_rows = len(df)

    columns = [_profile_column(df[c], y, target) for c in df.columns if c != target]

    if n_rows < TINY_DATASET:
        warn.append(f"tiny dataset: only {n_rows} rows; CV scores will be noisy")
    if ptype != ProblemType.regression:
        counts = y.value_counts()
        ratio = float(counts.iloc[0] / counts.iloc[-1])
        if ratio > IMBALANCE_RATIO:
            warn.append(
                f"class imbalance {ratio:.1f}:1 "
                f"(majority '{counts.index[0]}' vs minority '{counts.index[-1]}')"
            )
        rare = [str(k) for k, c in counts.items() if c < task.cv_folds]
        if rare:
            warn.append(f"classes with fewer than {task.cv_folds} rows (stratification is limited): {rare}")
    leaks = [c.name for c in columns if "possible_target_leak" in c.flags]
    if leaks:
        warn.append(f"possible target leakage in columns: {leaks}")
    ids = [c.name for c in columns if c.kind == ColumnKind.id]
    if ids:
        warn.append(f"id-like columns (probably useless as features): {ids}")

    sample_src = sample_from if sample_from is not None else df
    return DataProfile(
        n_rows=n_rows,
        n_cols=int(df.shape[1]),
        target=target,
        problem_type=ptype,
        metric=metric,
        columns=columns,
        target_summary=_target_summary(y, ptype),
        warnings=warn,
        sample_rows=_sample_rows(sample_src, task.seed),
    )
