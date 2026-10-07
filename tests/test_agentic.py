"""ScriptedChat-driven tests of the agentic state machine (no network)."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from autotinker.agent.router import ScriptedChat
from autotinker.contracts import ColumnKind, ColumnProfile, Decision, ProblemType
from autotinker.evolve.agentic import AgenticConfig, run_agentic, run_intake
from autotinker.obs.events import parse_event
from autotinker.obs.record import RunRecord
from tests.agentic_helpers import PROFILER, code_reply, critic, fake_code, judge, plan, reporter
from tests.conftest import FakeHarness

STARTER = fake_code(0.5, tag="starter")


def _cfg(**kw: object) -> AgenticConfig:
    base: dict[str, object] = dict(max_experiments=6, n_drafts=2, ablation_every=0, stall_for_tune=99)
    base.update(kw)
    return AgenticConfig(**base)  # type: ignore[arg-type]


def _run(chat: ScriptedChat, tmp_path: Path, cfg: AgenticConfig, h: FakeHarness | None = None) -> RunRecord:
    return run_agentic(
        h or FakeHarness(),
        chat,
        cfg=cfg,
        goal="predict y",
        run_dir=tmp_path,
        starter_code=STARTER,
        contract_doc="CONTRACT",
    )


def test_state_machine_phases_events_and_record(tmp_path: Path) -> None:
    chat = ScriptedChat(
        {
            "profiler": [PROFILER],
            "planner": [
                plan("random forest", "random_forest", radical=True),
                plan("logistic regression", "linear", radical=True),
                plan("tiny tweak", "linear", cat="hyperparameters"),
                plan("add interactions", "linear", cat="feature_engineering"),
            ],
            "coder": [
                code_reply(fake_code(0.6, tag="rf")),
                code_reply(fake_code(0.65, tag="lr")),
                code_reply(fake_code(0.65001, tag="tweak")),
                code_reply(fake_code(0.70, tag="inter")),
            ],
            "critic": [critic()] * 6,
            "judge": [judge("A")] * 4,
            "ensembler": [json.dumps({"strategy": "soft_vote", "members": ["e004", "e002"], "plain": "mix"})],
            "reporter": [reporter({"n_experiments": 6, "best_cv": 123.0})],
        }
    )
    rec = _run(chat, tmp_path, _cfg())
    phases = [e.phase for e in rec.experiments]
    assert phases == ["baseline", "draft", "draft", "improve", "improve", "ensemble"]
    status = [e.status for e in rec.experiments]
    assert status[:5] == [Decision.keep, Decision.keep, Decision.keep, Decision.discard, Decision.keep]
    assert rec.stop and rec.stop["reason"] == "max_experiments"
    assert rec.final is not None and rec.best_exp_id in ("e004", "e005")
    # every LLM experiment carries planner -> coder -> executor -> critic steps
    roles = [s.role for s in rec.experiments[1].steps]
    assert roles[:3] == ["planner", "coder", "executor"] and "critic" in roles and "judge" in roles
    assert all(s.plain for s in rec.experiments[1].steps)
    assert "judge" not in [s.role for s in rec.experiments[3].steps]  # judge only on gate keeps
    coder = rec.experiments[1].steps[1]
    assert coder.code and coder.diff and coder.provider == "scripted" and coder.tokens_in == 100
    assert rec.experiments[1].steps[0].reasoning == "thinking as planner"
    assert [s.role for s in rec.steps] == ["profiler", "reporter"]
    # report: numbers checked with NumericDiff and corrected
    assert rec.report is not None
    assert rec.report["numbers"]["best_cv"] != 123.0
    assert rec.report["checks"]["faithful"] is False
    assert rec.report["numbers"]["n_experiments"] == 6
    # events: valid JSONL, new event types present, run_started first, report before close
    lines = (tmp_path / "events.jsonl").read_text().splitlines()
    events = [parse_event(ln) for ln in lines]
    types = [e.type for e in events]
    assert types[0] == "run_started"
    for t in ("agent_step_started", "agent_reasoning", "agent_step_finished", "report_ready", "llm_call"):
        assert t in types
    assert types.index("run_finished") < types.index("report_ready")
    assert [e.seq for e in events] == list(range(1, len(events) + 1))
    on_disk = RunRecord.model_validate_json((tmp_path / "run.json").read_text())
    assert on_disk.report is not None and len(on_disk.experiments) == 6
    assert (tmp_path / "report.json").exists()
    assert rec.usage["judge"]["calls"] == 3


def test_debugger_fixes_then_abandons_after_five(tmp_path: Path) -> None:
    chat = ScriptedChat(
        {
            "profiler": [PROFILER],
            "planner": [plan("broken then fixed"), plan("hopeless")],
            "coder": [
                code_reply(fake_code(None, crash=True)),
                code_reply(fake_code(None, crash=True, tag="h")),
            ],
            "debugger": [code_reply(fake_code(0.6, tag="fixed"), "Fixed the bug.")]
            + [code_reply(fake_code(None, crash=True, tag=f"d{i}")) for i in range(5)],
            "critic": [critic()] * 3,
            "judge": [judge("A")] * 3,
            "reporter": [reporter()],
        }
    )
    rec = _run(chat, tmp_path, _cfg(max_experiments=4, n_drafts=2))
    e1, e2 = rec.experiments[1], rec.experiments[2]
    assert rec.experiments[3].phase == "ensemble"  # last slot; the ensembler has no reply -> top-k fallback
    assert e1.status == Decision.keep and e1.repair_attempts == 1
    assert [s.role for s in e1.steps][:5] == ["planner", "coder", "executor", "debugger", "executor"]
    assert e2.status == Decision.crash and e2.repair_attempts == 5 and "abandoned" in e2.reason
    assert sum(1 for s in e2.steps if s.role == "debugger") == 5


def test_critic_leak_and_judge_disagreement_discard(tmp_path: Path) -> None:
    chat = ScriptedChat(
        {
            "profiler": [PROFILER],
            "planner": [plan("leaky"), plan("disputed")],
            "coder": [code_reply(fake_code(0.8, tag="a")), code_reply(fake_code(0.8, tag="b"))],
            "critic": [critic("leak"), critic("valid")],
            "judge": [judge("B")],
            "reporter": [reporter()],
        }
    )
    rec = _run(chat, tmp_path, _cfg(max_experiments=3, n_drafts=2, judge_disagreement="discard"))
    e1, e2 = rec.experiments[1], rec.experiments[2]
    assert e1.status == Decision.discard and e1.reason.startswith("critic: leak")
    assert e2.status == Decision.discard and "disagreement" in e2.reason
    assert rec.best_exp_id == "e000"
    assert rec.usage["judge"]["disagree"] == 1 and any(
        "judge said suspicious" in n for n in rec.usage["notes"]
    )


def test_judge_disagreement_note_mode_keeps(tmp_path: Path) -> None:
    chat = ScriptedChat(
        {
            "profiler": [PROFILER],
            "planner": [plan("disputed")],
            "coder": [code_reply(fake_code(0.8))],
            "critic": [critic("valid")],
            "judge": [judge("B")],
            "reporter": [reporter()],
        }
    )
    rec = _run(chat, tmp_path, _cfg(max_experiments=2, n_drafts=1, judge_disagreement="note"))
    assert rec.experiments[1].status == Decision.keep and "flagged for review" in rec.experiments[1].reason


def test_judge_says_leak_but_critic_valid_is_kept_and_flagged_by_default(tmp_path: Path) -> None:
    chat = ScriptedChat(
        {
            "profiler": [PROFILER],
            "planner": [plan("zeros as missing")],
            "coder": [code_reply(fake_code(0.8))],
            "critic": [critic("valid")],
            "judge": [judge("C")],
            "reporter": [reporter()],
        }
    )
    rec = _run(chat, tmp_path, _cfg(max_experiments=2, n_drafts=1))
    e1 = rec.experiments[1]
    assert e1.status == Decision.keep and "flagged for review" in e1.reason and "judge said leak" in e1.reason
    assert rec.usage["judge"]["disagree"] == 1


def test_agent_failures_count_as_crashes_and_abort(tmp_path: Path) -> None:
    chat = ScriptedChat({"profiler": [PROFILER], "planner": ["nonsense"] * 6, "reporter": [reporter()]})
    rec = _run(chat, tmp_path, _cfg(max_experiments=10, n_drafts=1))
    assert rec.stop and rec.stop["reason"] == "proposer_failure"
    assert [e.status for e in rec.experiments[1:]] == [Decision.crash] * 3
    planner_steps = [s for s in rec.experiments[1].steps if s.role == "planner"]
    assert planner_steps and planner_steps[0].status == "error"


def test_token_cap_stops_the_run(tmp_path: Path) -> None:
    chat = ScriptedChat(
        {
            "profiler": [PROFILER],
            "planner": [plan("idea a"), plan("idea b")],
            "coder": [code_reply(fake_code(0.6)), code_reply(fake_code(0.7))],
            "critic": [critic()] * 2,
            "judge": [judge()] * 2,
            "reporter": [reporter()],
        }
    )
    rec = _run(chat, tmp_path, _cfg(max_experiments=10, max_tokens=500))
    assert rec.stop and rec.stop["reason"] == "max_tokens"


def test_ensemble_at_ceiling(tmp_path: Path) -> None:
    """When the ceiling fires early, the ensemble still runs once before the locked test."""
    chat = ScriptedChat(
        {
            "profiler": [PROFILER],
            "planner": [plan("idea a", "linear"), plan("idea b", "svm")]
            + [plan(f"tweak {i}", "svm", radical=True) for i in range(10)],
            "coder": [code_reply(fake_code(0.6, tag="a")), code_reply(fake_code(0.7, tag="b"))]
            + [code_reply(fake_code(0.7, tag=f"t{i}")) for i in range(10)],
            "critic": [critic()] * 20,
            "judge": [judge()] * 20,
            "ensembler": [
                json.dumps({"strategy": "stacking", "members": ["e002", "e001"], "plain": "stack"})
            ],
            "reporter": [reporter()],
        }
    )
    rec = _run(chat, tmp_path, _cfg(max_experiments=30, min_experiments=4))
    assert rec.stop and rec.stop["reason"] == "ceiling"
    assert rec.experiments[-1].phase == "ensemble"
    assert "StackingClassifier" in rec.experiments[-1].code


# ---------------------------------------------------------------- privacy


def test_no_data_rows_reach_providers_that_train_on_inputs(tmp_path: Path) -> None:
    sentinel = "SENTINEL_CELL_VALUE"
    h = FakeHarness()
    cols = list(h.profile.columns)
    cols[2] = ColumnProfile(
        name="c",
        dtype="object",
        kind=ColumnKind.categorical,
        missing_frac=0.0,
        n_unique=3,
        examples=[sentinel],
        top_values={sentinel: 5},
    )
    h.profile = h.profile.model_copy(update={"columns": cols, "sample_rows": [{"a": 1, "c": sentinel}]})
    chat = ScriptedChat(
        {
            "profiler": [PROFILER],
            "planner": [plan("idea a"), plan("idea b")],
            "coder": [code_reply(fake_code(0.6)), code_reply(fake_code(0.7))],
            "critic": [critic()] * 2,
            "judge": [judge()] * 2,
            "ensembler": [json.dumps({"strategy": "soft_vote", "members": ["e001", "e002"], "plain": "x"})],
            "reporter": [reporter()],
        }
    )
    _run(chat, tmp_path, _cfg(max_experiments=4), h)
    seen = {r.role for r in chat.requests}
    assert {"profiler", "planner", "coder", "critic", "judge", "reporter"} <= seen
    for r in chat.requests:
        text = r.system + json.dumps(r.messages)
        if r.privacy:
            assert r.role in ("profiler", "intake")
        else:
            assert sentinel not in text, f"{r.role} leaked a cell value"
    assert any(sentinel in json.dumps(r.messages) for r in chat.requests if r.role == "profiler")


# ---------------------------------------------------------------- intake


def test_intake_infers_target_and_validates_metric() -> None:
    df = pd.DataFrame({"x": range(40), "churn": ["yes", "no"] * 20})
    chat = ScriptedChat(
        [
            json.dumps(
                {
                    "target": "churn",
                    "problem_type": "binary",
                    "metric": "rmse",
                    "goal": "predict churn",
                    "plain": "ok",
                }
            )
        ]
    )
    d = run_intake(chat, df, goal="predict churn")
    assert d.target == "churn" and d.metric is None  # rmse is not valid for a binary target
    assert d.problem_type == ProblemType.binary and d.step is not None
    assert chat.requests[0].privacy is True  # the preview holds data rows

    chat2 = ScriptedChat(
        [json.dumps({"target": "nope", "problem_type": "binary", "metric": "roc_auc", "plain": "?"})]
    )
    with pytest.raises(ValueError, match="could not infer the target"):
        run_intake(chat2, df)
    chat3 = ScriptedChat(
        [json.dumps({"target": "churn", "problem_type": "binary", "metric": "accuracy", "plain": "ok"})]
    )
    d3 = run_intake(chat3, df, target="churn")
    assert d3.metric is not None and d3.metric.value == "accuracy"
