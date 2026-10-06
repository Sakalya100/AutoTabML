from __future__ import annotations

import pickle
from pathlib import Path

import numpy as np
import pandas as pd

from autotinker.contracts import ProblemType, TaskSpec
from autotinker.data import load_source, resolve_task
from autotinker.harness.splits import make_splits, persist_splits

DATA = Path(__file__).resolve().parent.parent / "examples" / "data"


def _iris_task(**kw: object) -> tuple[pd.DataFrame, TaskSpec]:
    df = load_source(DATA / "iris_classification.csv")
    return df, resolve_task(df, TaskSpec(target="variety", **kw))  # type: ignore[arg-type]


def test_deterministic_for_seed_and_differs_across_seeds() -> None:
    df, task = _iris_task(seed=3)
    a, b = make_splits(df, task), make_splits(df, task)
    pd.testing.assert_frame_equal(a.X_test, b.X_test)
    assert np.array_equal(a.y_dev, b.y_dev)
    assert all(np.array_equal(x[1], y[1]) for x, y in zip(a.folds, b.folds, strict=True))
    c = make_splits(df, task.model_copy(update={"seed": 4}))
    assert not a.X_test.equals(c.X_test)


def test_sizes_partition_and_stratification() -> None:
    df, task = _iris_task()
    s = make_splits(df, task)
    assert len(s.X_dev) + len(s.X_select) + len(s.X_test) == 150
    assert len(s.X_test) == 23 and abs(len(s.X_select) - 22) <= 1
    assert s.classes == ["Setosa", "Versicolor", "Virginica"]
    for y in (s.y_test, s.y_select, s.y_dev):
        counts = np.bincount(y, minlength=3)
        assert counts.max() - counts.min() <= 1  # stratified
    assert s.stratified and len(s.folds) == task.cv_folds * task.cv_repeats
    for tr, va in s.folds:
        assert len(np.intersect1d(tr, va)) == 0 and len(tr) + len(va) == len(s.X_dev)
        counts = np.bincount(s.y_dev[va], minlength=3)
        assert counts.max() - counts.min() <= 1
    # every dev row is validated exactly once per repeat
    first = np.sort(np.concatenate([va for _, va in s.folds[: task.cv_folds]]))
    assert np.array_equal(first, np.arange(len(s.X_dev)))


def test_missing_target_dropped_and_tiny_class_fallback() -> None:
    rng = np.random.default_rng(0)
    y = np.array(["a"] * 60 + ["b"] * 37 + ["c"] * 3, dtype=object)
    df = pd.DataFrame({"x": rng.normal(size=100), "y": y})
    df.loc[0, "y"] = None
    task = resolve_task(df, TaskSpec(target="y"))
    assert task.problem_type == ProblemType.multiclass
    s = make_splits(df, task)
    assert any("missing target" in w for w in s.warnings)
    assert len(s.X_dev) + len(s.X_select) + len(s.X_test) == 99
    assert not s.stratified and any("not stratified" in w for w in s.warnings)


def test_regression_and_persisted_files_hide_holdout_labels(tmp_path: Path) -> None:
    df = load_source(DATA / "housing_regression.csv")
    task = resolve_task(df, TaskSpec(target="price"))
    s = make_splits(df, task)
    assert s.classes is None and s.y_dev.dtype == float
    dev_path, test_path = persist_splits(s, tmp_path)
    dev = pickle.loads(dev_path.read_bytes())
    test = pickle.loads(test_path.read_bytes())
    assert set(dev) == {"X_dev", "y_dev", "folds", "X_select"}
    assert set(test) == {"X_fit", "y_fit", "X_test"}
    assert "price" not in dev["X_dev"].columns and "price" not in test["X_test"].columns
