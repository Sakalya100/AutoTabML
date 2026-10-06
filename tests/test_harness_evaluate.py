"""End-to-end harness tests: real worker subprocesses, no mocks."""

from __future__ import annotations

from pathlib import Path

import pytest

from autotabml.contracts import HarnessProtocol, Metric, ProblemType, TaskSpec
from autotabml.data import load_source
from autotabml.harness import CONTRACT_DOC, STARTER_SOLUTION, Harness

DATA = Path(__file__).resolve().parent.parent / "examples" / "data"


@pytest.fixture(scope="module")
def iris(tmp_path_factory: pytest.TempPathFactory) -> Harness:
    df = load_source(DATA / "iris_na_classification.csv")
    task = TaskSpec(target="variety", metric=Metric.accuracy, cv_folds=3, cv_repeats=2)
    return Harness(df, task, tmp_path_factory.mktemp("iris"))


def test_harness_shape(iris: Harness) -> None:
    h: HarnessProtocol = iris
    assert h.profile.problem_type == ProblemType.multiclass
    assert iris.task.problem_type == ProblemType.multiclass and iris.task.metric == Metric.accuracy
    assert "sklearn" in iris.allowed_imports and "os" not in iris.allowed_imports
    assert "build_pipeline" in CONTRACT_DOC


def test_starter_on_iris_and_fold_order_is_fixed(iris: Harness) -> None:
    folds_before = iris.fold_indices
    a = iris.evaluate(STARTER_SOLUTION, "e000")
    assert a.ok, a.error_tail
    assert a.cv is not None and len(a.cv.folds) == 6
    assert a.cv.mean > 0.85 and a.select_score is not None and a.select_score > 0.8
    assert a.cv.se >= 0 and a.fit_time_s is not None and a.fit_time_s > 0
    b = iris.evaluate(STARTER_SOLUTION, "e001")
    assert b.ok and b.cv is not None
    assert b.cv.folds == a.cv.folds  # same folds, same seeds -> identical paired scores
    after = iris.fold_indices
    assert all((x[1] == y[1]).all() for x, y in zip(folds_before, after, strict=True))


def test_static_check_failure_is_reported_not_raised(iris: Harness) -> None:
    r = iris.evaluate("import os\ndef build_pipeline(p):\n    return None\n", "bad")
    assert not r.ok and r.error_kind == "static_check" and r.error_tail and "os" in r.error_tail


def test_runtime_error_tail(iris: Harness) -> None:
    code = "def build_pipeline(profile):\n    raise ValueError('boom from solution')\n"
    r = iris.evaluate(code, "boom")
    assert not r.ok and r.error_kind == "runtime"
    assert r.error_tail and "boom from solution" in r.error_tail and len(r.error_tail) <= 4000


def test_nan_predictions_are_invalid_output(iris: Harness) -> None:
    code = (
        "import numpy as np\n"
        "from sklearn.base import BaseEstimator, ClassifierMixin\n"
        "class NaNModel(BaseEstimator, ClassifierMixin):\n"
        "    def fit(self, X, y):\n"
        "        self.classes_ = np.unique(y)\n"
        "        return self\n"
        "    def predict(self, X):\n"
        "        return np.full(len(X), np.nan)\n"
        "def build_pipeline(profile):\n"
        "    return NaNModel()\n"
    )
    r = iris.evaluate(code, "nan")
    assert not r.ok and r.error_kind == "invalid_output", r.error_tail


def test_missing_predict_proba_for_proba_metric(tmp_path: Path) -> None:
    df = load_source(DATA / "iris_classification.csv")
    h = Harness(df, TaskSpec(target="variety", cv_folds=2, cv_repeats=1), tmp_path)
    assert h.task.metric == Metric.log_loss
    code = "from sklearn.svm import LinearSVC\ndef build_pipeline(profile):\n    return LinearSVC()\n"
    r = h.evaluate(code, "svc")
    assert not r.ok and r.error_kind == "invalid_output"
    assert r.error_tail and "predict_proba" in r.error_tail


def test_starter_on_housing_and_test_scored_once(tmp_path: Path) -> None:
    df = load_source(DATA / "housing_regression.csv")
    h = Harness(df, TaskSpec(target="price", cv_folds=3, cv_repeats=1), tmp_path)
    assert h.task.metric == Metric.rmse
    r = h.evaluate(STARTER_SOLUTION, "e000")
    assert r.ok, r.error_tail
    assert r.cv is not None and r.cv.mean < 0  # oriented: negated rmse
    rmse = Metric.rmse.to_raw(r.cv.mean)
    assert 0.5e6 < rmse < 2.5e6  # target std is ~1.87e6
    test = h.score_test(STARTER_SOLUTION)
    assert test < 0 and 0.5e6 < -test < 2.5e6
    with pytest.raises(RuntimeError, match="already"):
        h.score_test(STARTER_SOLUTION)


def test_binary_roc_auc_with_string_labels(tmp_path: Path) -> None:
    from sklearn.datasets import load_breast_cancer

    data = load_breast_cancer(as_frame=True)
    df = data.frame.copy()
    df["target"] = df["target"].map({0: "malignant", 1: "benign"})
    h = Harness(df, TaskSpec(target="target", cv_folds=3, cv_repeats=1), tmp_path)
    assert h.task.problem_type == ProblemType.binary and h.task.metric == Metric.roc_auc
    r = h.evaluate(STARTER_SOLUTION, "e000")
    assert r.ok, r.error_tail
    assert r.cv is not None and r.cv.mean > 0.95
    assert r.select_score is not None and r.select_score > 0.9
