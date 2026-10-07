"""The agentic state machine on the REAL harness (sandbox, Optuna tune mode, ablation, ensemble), driven by
ScriptedChat. No network."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from autotinker.agent.router import ScriptedChat
from autotinker.api import agentic_run
from autotinker.contracts import Decision
from autotinker.harness.static_check import static_check
from tests.agentic_helpers import PROFILER, code_reply, critic, judge, plan, reporter

DATA = Path(__file__).resolve().parents[1] / "examples" / "data" / "iris_classification.csv"

RF = """from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline


def build_pipeline(profile):
    num = [c["name"] for c in profile["columns"] if c["kind"] == "numeric"]
    prep = ColumnTransformer([("num", SimpleImputer(strategy="median"), num)])
    return Pipeline([("prep", prep), ("model", RandomForestClassifier(n_estimators=30, random_state=0))])
"""

LR = """from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


def build_pipeline(profile):
    num = [c["name"] for c in profile["columns"] if c["kind"] == "numeric"]
    prep = ColumnTransformer([("num", SimpleImputer(strategy="median"), num)])
    model = LogisticRegression(max_iter=500)
    return Pipeline([("prep", prep), ("scale", StandardScaler()), ("model", model)])
"""

BROKEN = LR.replace("max_iter=500", "max_iter=500, bogus_param=1")

TUNE = json.dumps(
    {
        "params": {
            "model__max_depth": {"type": "int", "low": 2, "high": 6},
            "model__learning_rate": {"type": "float", "low": 0.03, "high": 0.3, "log": True},
        },
        "n_trials": 4,
        "plain": "Search depth and learning rate.",
    }
)


@pytest.mark.timeout(900)
def test_agentic_run_on_real_harness(tmp_path: Path) -> None:
    from autotinker.evolve.agentic import AgenticConfig

    chat = ScriptedChat(
        {
            "intake": [
                json.dumps(
                    {
                        "target": "variety",
                        "problem_type": "multiclass",
                        "metric": "accuracy",
                        "goal": "predict the iris variety",
                        "plain": "We will predict the flower variety.",
                    }
                )
            ],
            "profiler": [PROFILER],
            "planner": [plan("random forest", "random_forest", radical=True)]
            + [plan(f"scaled logistic regression {i}", "linear") for i in range(6)],
            "coder": [code_reply(RF), code_reply(BROKEN)] + [code_reply(LR)] * 5,
            "debugger": [code_reply(LR, "Removed the bad parameter.")] * 3,
            "tuner": [TUNE] * 2,
            "critic": [critic()] * 10,
            "judge": [judge()] * 10,
            "ensembler": [json.dumps({"strategy": "soft_vote", "members": ["e000", "e001"], "plain": "mix"})]
            * 2,
            "reporter": [reporter()],
        }
    )
    cfg = AgenticConfig(n_drafts=1, ablation_every=2, stall_for_tune=1, tune_trials=4, tune_budget_s=40)
    run = agentic_run(
        str(DATA),
        goal="which iris is it",
        workdir=tmp_path,
        backend=chat,
        max_experiments=6,
        config=cfg,
        cv_folds=3,
        cv_repeats=1,
    )
    rec = run.record
    assert rec.task.target == "variety" and rec.profile.metric.value == "accuracy"
    assert [s.role for s in rec.steps][:2] == ["intake", "profiler"]
    phases = [e.phase for e in rec.experiments]
    assert phases[0] == "baseline" and phases[1] == "draft"
    assert "tune" in phases and phases[-1] == "ensemble", phases
    tune = next(e for e in rec.experiments if e.phase == "tune")
    assert tune.trials and any(t.value is not None for t in tune.trials)
    assert "TUNED_PARAMS" in tune.code
    assert any(s.role == "optuna" for s in tune.steps)
    # ablation ran before an improve experiment and its result reached the planner prompt
    ablations = [s for e in rec.experiments for s in e.steps if s.role == "ablation"]
    assert ablations and ablations[0].output and "deltas" in ablations[0].output
    assert any("Ablation of the best pipeline" in json.dumps(r.messages) for r in chat.requests)
    # the broken coder output was debugged
    debugged = [e for e in rec.experiments if e.repair_attempts > 0]
    assert debugged and debugged[0].status != Decision.crash
    ens = rec.experiments[-1]
    assert ens.cv is not None, ens.error_tail  # the generated ensemble passes the static check and runs
    assert rec.final is not None and rec.report is not None
    types = [json.loads(ln)["type"] for ln in (run.run_dir / "events.jsonl").read_text().splitlines()]  # type: ignore[operator]
    assert "hpo_trial" in types and "sandbox_log" in types and types[-1] == "report_ready"


def test_codegen_outputs_pass_static_check() -> None:
    from autotinker.evolve import codegen

    tuned = codegen.with_params(
        RF, {"model__max_depth": 3, "model__criterion": "gini", "model__bootstrap": True}
    )
    assert static_check(tuned)[0] == []
    variants = codegen.ablation_variants(LR)
    assert [n for n, _ in variants] == ["num", "prep", "scale"]
    for _, code in variants:
        assert static_check(code)[0] == []
    ens = codegen.ensemble_code([("e001", RF), ("e002", LR)], strategy="stacking")
    assert static_check(ens)[0] == []
    ns: dict[str, object] = {}
    exec(compile(ens, "ens.py", "exec"), ns)
    df = pd.read_csv(DATA)
    from autotinker.contracts import TaskSpec
    from autotinker.data.profiler import profile_dataframe, resolve_task

    task = resolve_task(df, TaskSpec(target="variety"))
    prof = profile_dataframe(df, task).model_dump(mode="json")
    est = ns["build_pipeline"](prof)  # type: ignore[operator]
    X, y = df.drop(columns=["variety"]), pd.factorize(df["variety"], sort=True)[0]
    est.fit(X, y)
    assert est.predict_proba(X).shape == (150, 3)


def test_without_columns_hides_profiler_exclusions() -> None:
    from autotinker.evolve import codegen
    from autotinker.harness.contract import STARTER_SOLUTION

    code = codegen.without_columns(STARTER_SOLUTION, ["sepal.length"])
    assert static_check(code)[0] == []
    ns: dict[str, object] = {}
    exec(compile(code, "s.py", "exec"), ns)
    prof = {
        "problem_type": "multiclass",
        "columns": [{"name": "sepal.length", "kind": "numeric"}, {"name": "petal.width", "kind": "numeric"}],
    }
    est = ns["build_pipeline"](prof)  # type: ignore[operator]
    cols = est.named_steps["preprocess"].transformers[0][2]
    assert cols == ["petal.width"]
