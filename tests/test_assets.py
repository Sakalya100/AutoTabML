"""Run assets: locked-test charts, the dumped final model, and the assets_ready event."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import pytest

from autotinker.agent.router import ScriptedChat
from autotinker.contracts import Metric, TaskSpec
from autotinker.evolve.agentic import AgenticConfig, run_agentic
from autotinker.harness import STARTER_SOLUTION, Harness
from autotinker.harness.core import TestOutputs
from autotinker.obs import assets
from autotinker.obs.assets import build_assets_event, classification_charts, downsample, regression_charts
from autotinker.obs.events import AssetsReady, parse_event
from tests.agentic_helpers import PROFILER, code_reply, critic, fake_code, judge, plan, reporter
from tests.conftest import FakeHarness

DATA = Path(__file__).resolve().parents[1] / "examples" / "data"


def _proba(y: np.ndarray, k: int, seed: int = 0) -> np.ndarray:
    """Noisy but informative class probabilities for encoded labels `y`."""
    rng = np.random.default_rng(seed)
    logits = rng.normal(0, 1, (len(y), k))
    logits[np.arange(len(y)), y] += 1.5
    e = np.exp(logits)
    return e / e.sum(axis=1, keepdims=True)


def _by_id(charts: list) -> dict:
    return {c.id: c for c in charts}


# ---------------------------------------------------------------- chart computation


def test_downsample_keeps_endpoints_and_bound() -> None:
    xs = np.linspace(0, 1, 5000)
    pts = downsample(xs, xs**2, 200)
    assert len(pts) <= 200 and pts[0] == [0.0, 0.0] and pts[-1] == [1.0, 1.0]
    assert downsample([0.0, 1.0], [0.0, 1.0], 200) == [[0.0, 0.0], [1.0, 1.0]]
    assert downsample([], [], 200) == []


def test_binary_charts() -> None:
    y = np.random.default_rng(1).integers(0, 2, 3000)
    charts = _by_id(classification_charts(y, _proba(y, 2), _proba(y, 2), ["no", "yes"]))
    assert set(charts) == {"roc", "pr", "confusion"}
    roc, pr, cm = charts["roc"], charts["pr"], charts["confusion"]
    assert roc.kind == "curve" and roc.diagonal and roc.series[0].name.startswith("AUC 0.")
    pts = roc.series[0].points
    assert len(pts) <= 200 and pts[0] == [0.0, 0.0] and pts[-1] == [1.0, 1.0]
    assert pr.diagonal is False and pr.series[0].name.startswith("AP ") and len(pr.series[0].points) <= 200
    assert pr.series[0].points[0][0] == 0.0 and pr.series[0].points[-1][0] == 1.0  # recall left to right
    assert cm.labels == ["no", "yes"] and sum(map(sum, cm.matrix)) == len(y)
    assert [sum(r) for r in cm.matrix] == [int((y == 0).sum()), int((y == 1).sum())]  # rows = actual


def test_multiclass_charts_per_class_and_macro() -> None:
    y = np.random.default_rng(2).integers(0, 4, 800)
    charts = _by_id(classification_charts(y, _proba(y, 4), _proba(y, 4), ["a", "b", "c", "d"]))
    assert set(charts) == {"roc", "confusion"}  # no PR curve for multiclass
    assert [s.name.split(" · ")[0] for s in charts["roc"].series] == ["a", "b", "c", "d"]
    assert np.array(charts["confusion"].matrix).shape == (4, 4)

    y12 = np.random.default_rng(3).integers(0, 12, 1200)
    many = _by_id(classification_charts(y12, _proba(y12, 12), _proba(y12, 12), [f"c{i}" for i in range(12)]))
    assert len(many["roc"].series) == 1 and many["roc"].series[0].name.startswith("macro AUC")
    assert len(many["confusion"].labels) == 12

    y25 = np.random.default_rng(4).integers(0, 25, 1000)
    huge = _by_id(classification_charts(y25, _proba(y25, 25), _proba(y25, 25), list(range(25))))
    assert "confusion" not in huge and "roc" in huge  # > 20 classes: no matrix


def test_labels_only_gives_confusion_matrix_only() -> None:
    y = np.array([0, 1, 2, 2, 1, 0])
    charts = classification_charts(y, np.array([0, 1, 2, 1, 1, 0]), None, ["x", "y", "z"])
    assert [c.id for c in charts] == ["confusion"]
    assert charts[0].matrix == [[2, 0, 0], [0, 2, 0], [0, 1, 1]]


def test_regression_charts() -> None:
    rng = np.random.default_rng(5)
    y = rng.normal(100, 20, 2000)
    p = y + rng.normal(0, 5, 2000)
    charts = _by_id(regression_charts(y, p))
    sc, hist = charts["pred_vs_actual"], charts["residuals"]
    assert sc.kind == "scatter" and sc.diagonal and len(sc.points) == 500
    assert sc.points == regression_charts(y, p)[0].points  # deterministic sample
    assert hist.kind == "histogram" and len(hist.bins) == 30 and sum(b.count for b in hist.bins) == 2000
    assert all(b.x0 < b.x1 for b in hist.bins)
    small = _by_id(regression_charts(y[:40], p[:40]))
    assert len(small["pred_vs_actual"].points) == 40 and sum(b.count for b in small["residuals"].bins) == 40


def test_event_stays_under_64kb_and_round_trips() -> None:
    y = np.random.default_rng(6).integers(0, 10, 20000)  # 10 one-vs-rest ROC series + a 10x10 matrix
    out = TestOutputs("multiclass", y, _proba(y, 10), _proba(y, 10), [f"class-{i}" for i in range(10)], None)
    ev = build_assets_event("run-x", None, "code", out)
    raw = ev.model_dump_json()
    assert len(raw) < 64 * 1024
    assert len(ev.charts[0].series) == 10  # type: ignore[union-attr]
    assert parse_event(raw) == ev and isinstance(parse_event(raw), AssetsReady)


# ---------------------------------------------------------------- the real harness and worker


CUSTOM = """from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline


class Wrapped(BaseEstimator, ClassifierMixin):
    def __init__(self, c=1.0):
        self.c = c

    def fit(self, X, y):
        self.model_ = LogisticRegression(C=self.c, max_iter=500).fit(X, y)
        self.classes_ = self.model_.classes_
        return self

    def predict(self, X):
        return self.model_.predict(X)

    def predict_proba(self, X):
        return self.model_.predict_proba(X)


def build_pipeline(profile):
    num = [c["name"] for c in profile["columns"] if c["kind"] == "numeric"]
    prep = ColumnTransformer([("num", SimpleImputer(strategy="median"), num)])
    return Pipeline([("prep", prep), ("model", Wrapped())])
"""


def test_worker_dumps_a_loadable_model_and_probabilities(tmp_path: Path) -> None:
    df = pd.read_csv(DATA / "iris_classification.csv")
    task = TaskSpec(target="variety", metric=Metric.accuracy, cv_folds=3, cv_repeats=1)
    h = Harness(df, task, tmp_path / "harness")
    h.score_test(CUSTOM)  # a class defined in the solution itself must pickle too
    out = h.test_outputs
    assert out is not None and out.model_path is not None and out.model_error is None
    assert out.proba is not None and out.proba.shape == (len(out.y_true), 3)  # accuracy run, still has proba
    ev = build_assets_event("r", tmp_path, CUSTOM, out)
    assert {c.id for c in ev.charts} == {"roc", "confusion"}
    files = {f.name: f for f in ev.files}
    assert files["model.joblib"].bytes == (tmp_path / "assets" / "model.joblib").stat().st_size > 0
    assert (tmp_path / "assets" / "pipeline.py").read_text() == CUSTOM
    sys.path.insert(0, str(tmp_path / "assets"))  # pipeline.py next to the model defines `Wrapped`
    try:
        model = joblib.load(tmp_path / "assets" / "model.joblib")
        pred = model.predict(h._splits.X_test.head(5))
    finally:
        sys.path.remove(str(tmp_path / "assets"))
        sys.modules.pop("pipeline", None)
        sys.modules.pop("predict", None)
    assert pred.shape == (5,) and set(pred) <= {"Setosa", "Versicolor", "Virginica"}  # decoded labels
    assert set(model.model.predict(h._splits.X_test.head(5))) <= {0, 1, 2}  # the raw estimator is still there


def test_unpicklable_model_does_not_fail_the_locked_test(tmp_path: Path) -> None:
    df = pd.read_csv(DATA / "housing_regression.csv")
    h = Harness(df, TaskSpec(target="price", cv_folds=3, cv_repeats=1), tmp_path / "harness")
    code = STARTER_SOLUTION.replace(
        "    return Pipeline([",
        "    model.unpicklable_ = lambda v: v\n    return Pipeline([",
    )
    assert np.isfinite(h.score_test(code))
    out = h.test_outputs
    assert out is not None and out.model_path is None and out.model_error
    ev = build_assets_event("r", tmp_path, code, out)
    assert [f.name for f in ev.files] == ["pipeline.py"]  # no model: no predict.py / card / requirements
    assert {c.id for c in ev.charts} == {"pred_vs_actual", "residuals"}


# ---------------------------------------------------------------- predict.py, model card, requirements


def _assets_for(tmp_path: Path, df: pd.DataFrame, task: TaskSpec, code: str = STARTER_SOLUTION) -> Path:
    h = Harness(df, task, tmp_path / "harness")
    h.score_test(code)
    ev = build_assets_event("run-1", tmp_path, code, h.test_outputs)
    assert len(ev.model_dump_json()) < 64 * 1024
    kinds = {f.name: f.kind for f in ev.files}
    assert kinds == {
        "model.joblib": "model",
        "pipeline.py": "code",
        "predict.py": "script",
        "requirements.txt": "text",
        "model_card.json": "json",
    }
    return tmp_path / "assets"


def _run_predict(assets_dir: Path, rows: pd.DataFrame, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    """`python predict.py rows.csv -o out.csv` in a clean process, from another directory."""
    rows.to_csv(tmp_path / "rows.csv", index=False)
    return subprocess.run(
        [
            sys.executable,
            str(assets_dir / "predict.py"),
            str(tmp_path / "rows.csv"),
            "-o",
            str(tmp_path / "out.csv"),
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
    )


def _run_ok(assets_dir: Path, rows: pd.DataFrame, tmp_path: Path) -> Path:
    res = _run_predict(assets_dir, rows, tmp_path)
    assert res.returncode == 0, res.stderr
    return tmp_path / "out.csv"


def _yes_no(n: int = 240) -> pd.DataFrame:
    rng = np.random.default_rng(0)
    x = rng.normal(0, 1, n)
    city = rng.choice(["Paris", "Lima", "Oslo"], n)
    return pd.DataFrame(
        {
            "customer_id": np.arange(1000, 1000 + n),
            "x": x,
            "city": city,
            "churn": np.where(x + (city == "Lima") + rng.normal(0, 0.5, n) > 0.5, "Yes", "No"),
        }
    )


def test_predict_script_binary_string_labels(tmp_path: Path) -> None:
    df = _yes_no()
    d = _assets_for(tmp_path, df, TaskSpec(target="churn", metric=Metric.roc_auc, cv_folds=3, cv_repeats=1))
    card = json.loads((d / "model_card.json").read_text())
    assert card["target"] == "churn" and card["problem_type"] == "binary" and card["metric"] == "roc_auc"
    assert card["classes"] == ["No", "Yes"] and card["label_decoding"] == "wrapper"
    assert [f["name"] for f in card["features"]] == ["customer_id", "x", "city"]
    assert card["dropped_columns"] == ["customer_id"]
    assert set(card["example_row"]) == {"customer_id", "x", "city"}
    assert 0 <= card["test_score"] <= 1 and card["run_id"] == "run-1" and card["created_at"]
    assert {"python", "scikit-learn", "numpy", "pandas", "scipy", "joblib"} <= set(card["versions"])

    # fresh rows: columns shuffled, the target and an extra column present, the id column missing
    rows = df.drop(columns=["customer_id"]).head(20)[["city", "churn", "x"]].assign(note="extra")
    res = _run_predict(d, rows, tmp_path)
    assert res.returncode == 0, res.stderr
    out = pd.read_csv(tmp_path / "out.csv")
    assert list(out.columns) == ["prediction", "proba_No", "proba_Yes"]
    assert set(out["prediction"]) <= {"Yes", "No"} and len(out) == 20
    assert np.allclose(out["proba_No"] + out["proba_Yes"], 1.0)
    assert (out["prediction"] == np.where(out["proba_Yes"] >= 0.5, "Yes", "No")).mean() > 0.9


def test_predict_script_multiclass_names_and_python_api(tmp_path: Path) -> None:
    df = pd.read_csv(DATA / "iris_classification.csv")
    d = _assets_for(
        tmp_path, df, TaskSpec(target="variety", metric=Metric.accuracy, cv_folds=3, cv_repeats=1)
    )
    res = _run_predict(d, df.sample(15, random_state=1), tmp_path)
    assert res.returncode == 0, res.stderr
    out = pd.read_csv(tmp_path / "out.csv")
    names = ["Setosa", "Versicolor", "Virginica"]
    assert list(out.columns) == ["prediction", *(f"proba_{c}" for c in names)]
    assert set(out["prediction"]) <= set(names)
    # importable too: `from predict import load, predict`
    code = (
        "import pandas as pd; from predict import load, predict; "
        f"df = pd.read_csv({str(DATA / 'iris_classification.csv')!r}).head(3); "
        "m = load(); print(list(predict(m, df)['prediction'])); print(list(m.predict(df)))"
    )
    run = subprocess.run([sys.executable, "-c", code], cwd=d, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    assert run.stdout.splitlines() == ["['Setosa', 'Setosa', 'Setosa']"] * 2


def test_predict_script_regression_and_requirements(tmp_path: Path) -> None:
    df = pd.read_csv(DATA / "housing_regression.csv")
    d = _assets_for(tmp_path, df, TaskSpec(target="price", cv_folds=3, cv_repeats=1))
    card = json.loads((d / "model_card.json").read_text())
    assert card["problem_type"] == "regression" and card["classes"] is None and card["test_score"] > 0
    res = _run_predict(d, df.drop(columns=["price"]).head(10), tmp_path)
    assert res.returncode == 0, res.stderr
    out = pd.read_csv(tmp_path / "out.csv")
    assert list(out.columns) == ["prediction"] and out["prediction"].between(1e5, 1e8).all()

    reqs = (d / "requirements.txt").read_text().splitlines()
    pins = dict(ln.split("==") for ln in reqs if ln and not ln.startswith("#"))
    import scipy
    import sklearn

    assert pins["scikit-learn"] == sklearn.__version__ and pins["numpy"] == np.__version__
    assert pins["pandas"] == pd.__version__ and pins["joblib"] == joblib.__version__
    assert pins["scipy"] == scipy.__version__ and "lightgbm" not in pins  # not imported by the solution


def test_predict_script_missing_column_is_a_clear_error(tmp_path: Path) -> None:
    df = pd.read_csv(DATA / "iris_classification.csv")
    d = _assets_for(
        tmp_path, df, TaskSpec(target="variety", metric=Metric.accuracy, cv_folds=3, cv_repeats=1)
    )
    res = _run_predict(d, df.drop(columns=["petal.width", "variety"]).head(5), tmp_path)
    assert res.returncode == 2
    assert "missing column(s): petal.width" in res.stderr and "Traceback" not in res.stderr
    assert not (tmp_path / "out.csv").exists()


def _predict_file(d: Path, path: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(d / "predict.py"), str(path), "-o", str(path.with_suffix(".out.csv")), *extra],
        cwd=path.parent,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_predict_script_reads_other_delimiters_and_decimal_commas(tmp_path: Path) -> None:
    df = pd.read_csv(DATA / "iris_classification.csv")
    d = _assets_for(
        tmp_path, df, TaskSpec(target="variety", metric=Metric.accuracy, cv_folds=3, cv_repeats=1)
    )
    assert json.loads((d / "model_card.json").read_text())["csv_format"] is None  # the run was given none
    rows = df.sample(12, random_state=4).reset_index(drop=True)
    expected = pd.read_csv(_run_ok(d, rows, tmp_path))["prediction"].tolist()
    assert set(expected) <= {"Setosa", "Versicolor", "Virginica"}

    def as_text(sep: str, decimal: str) -> str:
        return rows.drop(columns=["variety"]).to_csv(index=False, sep=sep, decimal=decimal)

    cp1252 = rows.drop(columns=["variety"]).assign(note="café")  # an extra column, not valid UTF-8 as cp1252
    cases = {
        "semicolon_comma.csv": (as_text(";", ","), "utf-8"),
        "tab.tsv": (as_text("\t", "."), "utf-8"),
        "pipe_cp1252.csv": (cp1252.to_csv(index=False, sep="|", decimal=","), "cp1252"),
        "bom_semicolon.txt": ("\ufeff" + as_text(";", "."), "utf-8"),
    }
    for name, (text, enc) in cases.items():
        path = tmp_path / name
        path.write_bytes(text.encode(enc))
        res = _predict_file(d, path)
        assert res.returncode == 0, (name, res.stderr)
        got = pd.read_csv(path.with_suffix(".out.csv"))
        assert got["prediction"].tolist() == expected, name
        assert np.allclose(got.filter(like="proba_").sum(axis=1), 1.0)

    # explicit flags win over detection
    path = tmp_path / "forced.csv"
    path.write_text(as_text(";", ","))
    assert _predict_file(d, path, "--delimiter", ";", "--decimal", ",").returncode == 0
    assert pd.read_csv(path.with_suffix(".out.csv"))["prediction"].tolist() == expected


def test_card_records_the_training_csv_format_and_predict_uses_it(tmp_path: Path) -> None:
    df = pd.read_csv(DATA / "iris_classification.csv")
    h = Harness(
        df, TaskSpec(target="variety", metric=Metric.accuracy, cv_folds=3, cv_repeats=1), tmp_path / "h"
    )
    h.score_test(STARTER_SOLUTION)
    fmt = {"delimiter": ";", "encoding": "cp1252", "decimal": ","}
    build_assets_event("r", tmp_path, STARTER_SOLUTION, h.test_outputs, csv_format=fmt)
    d = tmp_path / "assets"
    assert json.loads((d / "model_card.json").read_text())["csv_format"] == fmt
    assert assets.clean_csv_format({"delimiter": None, "encoding": "", "decimal": None}) is None
    assert assets.clean_csv_format({"delimiter": "\t"}) == {
        "delimiter": "\t",
        "encoding": None,
        "decimal": None,
    }
    # the card's format (cp1252, ';', decimal comma) is used for a file that fits it
    rows = df.drop(columns=["variety"]).head(6)
    path = tmp_path / "new.csv"
    path.write_bytes(rows.to_csv(index=False, sep=";", decimal=",").encode("cp1252"))
    res = _predict_file(d, path)
    assert res.returncode == 0, res.stderr
    assert set(pd.read_csv(path.with_suffix(".out.csv"))["prediction"]) <= {
        "Setosa",
        "Versicolor",
        "Virginica",
    }
    # a comma file still works even though the card says ';' (the card is a hint, not a rule)
    path2 = tmp_path / "comma.csv"
    rows.to_csv(path2, index=False)
    assert _predict_file(d, path2).returncode == 0


def test_requirements_pin_boosters_only_when_imported() -> None:
    assert "lightgbm" not in assets.package_versions(STARTER_SOLUTION)
    assert assets.solution_imports("import lightgbm as lgb\nfrom xgboost import XGBClassifier\n") >= {
        "lightgbm",
        "xgboost",
    }
    text = assets.requirements_txt({"scikit-learn": "1.0", "numpy": "2.0"})
    assert "scikit-learn==1.0\nnumpy==2.0\n" in text and text.startswith("# Exact versions")


# ---------------------------------------------------------------- the agentic loop


def _chat() -> ScriptedChat:
    return ScriptedChat(
        {
            "profiler": [PROFILER],
            "planner": [plan("random forest", "random_forest", radical=True)],
            "coder": [code_reply(fake_code(0.6, tag="rf"))],
            "critic": [critic()] * 3,
            "judge": [judge("A")] * 3,
            "reporter": [reporter({})],
        }
    )


def test_assets_failure_does_not_fail_the_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(assets, "build_assets_event", boom)
    cfg = AgenticConfig(max_experiments=2, n_drafts=1, ablation_every=0, stall_for_tune=99)
    rec = run_agentic(
        FakeHarness(), _chat(), cfg=cfg, goal="g", run_dir=tmp_path, starter_code=fake_code(0.5, tag="s")
    )
    assert rec.final is not None and rec.report is not None
    types = [json.loads(ln)["type"] for ln in (tmp_path / "events.jsonl").read_text().splitlines()]
    assert "assets_ready" not in types and types[-1] == "report_ready" and "run_finished" in types
