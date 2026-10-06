from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from autotabml.contracts import ColumnKind, DataProfile, Metric, ProblemType, TaskSpec
from autotabml.data import infer_problem_type, load_source, profile_dataframe

DATA = Path(__file__).resolve().parent.parent / "examples" / "data"


def _roundtrip(p: DataProfile) -> None:
    text = p.model_dump_json()
    assert "NaN" not in text and "Infinity" not in text
    json.loads(text)
    assert DataProfile.model_validate_json(text) == p


def test_housing_profile() -> None:
    p = profile_dataframe(load_source(DATA / "housing_regression.csv"), TaskSpec(target="price"))
    assert p.problem_type == ProblemType.regression and p.metric == Metric.rmse
    assert p.n_rows == 545 and len(p.columns) == 12
    kinds = {c.name: c.kind for c in p.columns}
    assert kinds["area"] == ColumnKind.numeric
    assert kinds["mainroad"] == ColumnKind.boolean
    assert kinds["furnishingstatus"] == ColumnKind.categorical
    area = next(c for c in p.columns if c.name == "area")
    assert area.stats is not None and {"min", "max", "mean", "std", "q25", "q50", "q75", "skew"} <= set(
        area.stats
    )
    furn = next(c for c in p.columns if c.name == "furnishingstatus")
    assert furn.top_values is not None and sum(furn.top_values.values()) == 545
    assert p.target_summary["kind"] == "numeric"
    assert not any("possible_target_leak" in c.flags for c in p.columns)
    assert 1 <= len(p.sample_rows) <= 5
    _roundtrip(p)


def test_iris_profiles() -> None:
    p = profile_dataframe(load_source(DATA / "iris_classification.csv"), TaskSpec(target="variety"))
    assert p.problem_type == ProblemType.multiclass and p.metric == Metric.log_loss
    assert all(c.kind == ColumnKind.numeric for c in p.columns)
    assert p.target_summary["class_counts"] == {"Setosa": 50, "Versicolor": 50, "Virginica": 50}
    _roundtrip(p)

    pna = profile_dataframe(load_source(DATA / "iris_na_classification.csv"), TaskSpec(target="variety"))
    sw = next(c for c in pna.columns if c.name == "sepal.width")
    assert sw.kind == ColumnKind.numeric and sw.missing_frac == pytest.approx(2 / 150, abs=1e-6)
    assert all(e is not None for e in sw.examples)
    _roundtrip(pna)


def test_flags_and_kinds_on_synthetic() -> None:
    rng = np.random.default_rng(0)
    n = 300
    y = rng.integers(0, 2, n)
    df = pd.DataFrame(
        {
            "customer_id": np.arange(1000, 1000 + n),
            "const": ["a"] * n,
            "leak": y * 3.0 + 1,
            "hc": [f"cat{i % 120}" for i in range(n)],
            "mostly_missing": np.where(rng.random(n) < 0.6, np.nan, rng.random(n)),
            "when": pd.date_range("2020-01-01", periods=n).astype(str),
            "note": [f"this is a fairly long free text comment number {i} about things" for i in range(n)],
            "target_v2": rng.random(n),
            "x": rng.normal(size=n),
            "target": y,
        }
    )
    df.loc[[3, 7], "target"] = np.nan
    p = profile_dataframe(df, TaskSpec(target="target"))
    assert p.problem_type == ProblemType.binary and p.metric == Metric.roc_auc
    assert p.n_rows == n - 2
    assert any("missing target" in w for w in p.warnings)
    cols = {c.name: c for c in p.columns}
    assert cols["customer_id"].kind == ColumnKind.id and "id_like" in cols["customer_id"].flags
    assert cols["const"].kind == ColumnKind.constant and "constant" in cols["const"].flags
    assert "possible_target_leak" in cols["leak"].flags
    assert "possible_target_leak" in cols["target_v2"].flags  # name contains the target name
    assert "possible_target_leak" not in cols["x"].flags
    assert "high_cardinality" in cols["hc"].flags
    assert "many_missing" in cols["mostly_missing"].flags
    assert cols["when"].kind == ColumnKind.datetime
    assert cols["note"].kind == ColumnKind.text
    assert not any("tiny" in w for w in p.warnings)
    _roundtrip(p)


def test_leak_on_categorical_copy_and_imbalance_warning() -> None:
    labels = ["a"] * 220 + ["b"] * 20 + ["c"] * 10
    df = pd.DataFrame({"copy": labels, "f": np.arange(250) % 7, "y": labels})
    p = profile_dataframe(df, TaskSpec(target="y"))
    assert p.problem_type == ProblemType.multiclass
    assert "possible_target_leak" in next(c for c in p.columns if c.name == "copy").flags
    assert any("imbalance" in w for w in p.warnings)


def test_infer_problem_type() -> None:
    assert infer_problem_type(pd.Series([0, 1] * 50)) == ProblemType.binary
    assert infer_problem_type(pd.Series([0, 1, 2] * 100)) == ProblemType.multiclass
    assert infer_problem_type(pd.Series(np.arange(100))) == ProblemType.regression
    assert infer_problem_type(pd.Series(np.linspace(0, 1, 50))) == ProblemType.regression
    assert infer_problem_type(pd.Series(["x", "y", "z"] * 5)) == ProblemType.multiclass
    with pytest.raises(ValueError):
        infer_problem_type(pd.Series([1, 1, 1]))


def test_explicit_task_validation() -> None:
    df = load_source(DATA / "iris_classification.csv")
    with pytest.raises(ValueError, match="binary"):
        profile_dataframe(df, TaskSpec(target="variety", problem_type=ProblemType.binary))
    with pytest.raises(ValueError, match="not valid"):
        profile_dataframe(df, TaskSpec(target="variety", metric=Metric.rmse))
    with pytest.raises(ValueError, match="not found"):
        profile_dataframe(df, TaskSpec(target="nope"))
    p = profile_dataframe(df, TaskSpec(target="variety", metric=Metric.accuracy))
    assert p.metric == Metric.accuracy
