"""Every role through run_role with ScriptedChat: parsing, ValidJSON repair-once, failure, step records."""

from __future__ import annotations

import json
from typing import Any

import pytest

from autotinker.agent import evals
from autotinker.agent.roles import ROLES, RoleFailed, parse_code_reply, run_role
from autotinker.agent.roles import specs as S
from autotinker.agent.roles.schemas import TunerOut
from autotinker.agent.router import ScriptedChat
from autotinker.contracts import AgentStep
from tests.agentic_helpers import PROFILER, code_reply, critic, plan, reporter
from tests.conftest import make_profile

GOOD: dict[str, str] = {
    "intake": json.dumps(
        {
            "target": "y",
            "problem_type": "multiclass",
            "metric": "log_loss",
            "goal": "g",
            "plain": "We predict y.",
        }
    ),
    "profiler": PROFILER,
    "planner": plan("use extra trees", "extra_trees", radical=True),
    "coder": code_reply("def build_pipeline(profile):\n    return 1\n", "Wrote a tiny model."),
    "debugger": code_reply("def build_pipeline(profile):\n    return 2\n", "Fixed it."),
    "critic": critic("Valid"),
    "tuner": json.dumps(
        {
            "params": {"model__max_depth": {"type": "int", "low": 2, "high": 8}},
            "n_trials": 10,
            "plain": "Tune depth.",
        }
    ),
    "ensembler": json.dumps({"strategy": "soft_vote", "members": ["e001", "e002"], "plain": "Blend two."}),
    "reporter": reporter({"best_cv": 0.9}),
}


class Obs:
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    def step_started(self, exp_id: str | None, step: AgentStep) -> None:
        self.events.append(("start", step.role))

    def step_reasoning(self, exp_id: str | None, step: AgentStep, text: str) -> None:
        self.events.append(("reason", text))

    def step_finished(self, exp_id: str | None, step: AgentStep) -> None:
        self.events.append(("finish", step.status))


@pytest.mark.parametrize("role", sorted(GOOD))
def test_every_role_parses_and_records_a_step(role: str) -> None:
    spec = ROLES[role]
    chat = ScriptedChat([GOOD[role]])
    obs = Obs()
    call = run_role(chat, spec, "input", exp_id="e001", observer=obs)
    step = call.step
    assert step.role == role and step.status == "ok" and step.plain
    assert step.provider == "scripted" and step.model == f"scripted-{spec.alias}"
    assert step.tokens_in == 100 and step.tokens_out == 50 and step.reasoning == f"thinking as {role}"
    assert obs.events[0] == ("start", role) and obs.events[-1] == ("finish", "ok")
    assert chat.requests[0].alias == spec.alias and chat.requests[0].role == role
    if spec.kind == "code":
        assert step.code and "build_pipeline" in step.code
    else:
        assert step.output and "plain" in step.output


def test_repair_once_then_succeed() -> None:
    chat = ScriptedChat(["sorry, here you go: {not json", GOOD["critic"]])
    call = run_role(chat, S.CRITIC, "x")
    assert call.output.verdict == "valid" and len(chat.requests) == 2  # type: ignore[attr-defined]
    assert "could not be used" in chat.requests[1].messages[-1]["content"]
    assert call.step.tokens_in == 200


def test_two_bad_replies_fail_with_step() -> None:
    chat = ScriptedChat(["nope", '{"verdict": "maybe"}'])
    with pytest.raises(RoleFailed) as ei:
        run_role(chat, S.CRITIC, "x")
    assert ei.value.step.status == "error" and ei.value.step.error


def test_code_reply_parsing() -> None:
    out = parse_code_reply(
        "PLAIN: Switched to a forest.\n```python\ndef build_pipeline(p):\n    return 1\n```"
    )
    assert out.plain == "Switched to a forest." and out.code.startswith("def build_pipeline")
    for bad in ("no code here", "```python\ndef f(:\n```", "```python\ndef other(p):\n    return 1\n```"):
        with pytest.raises(ValueError):
            parse_code_reply(bad)


def test_tuner_schema_rejects_bad_spaces() -> None:
    with pytest.raises(ValueError):
        TunerOut.model_validate({"params": {}})
    with pytest.raises(ValueError):
        TunerOut.model_validate({"params": {"model__C": {"type": "float", "low": 2, "high": 1}}})
    with pytest.raises(ValueError):
        TunerOut.model_validate({"params": {"model__k": {"type": "categorical"}}})


def test_planner_normalises_category_and_family() -> None:
    chat = ScriptedChat(
        [json.dumps({"title": "go bigger", "category": "Feature Engineering", "family": "XGBoost"})]
    )
    out: Any = run_role(chat, S.PLANNER, "x").output
    assert out.category.value == "feature_engineering" and out.family == "other"


def test_profile_text_redaction() -> None:
    p = make_profile()
    cols = list(p.columns)
    cols[2] = cols[2].model_copy(update={"examples": ["SECRETVAL"], "top_values": {"SECRETVAL": 3}})
    p = p.model_copy(update={"columns": cols, "sample_rows": [{"c": "SECRETVAL"}]})
    assert "SECRETVAL" not in S.profile_text(p, rows=False)
    assert "SECRETVAL" in S.profile_text(p, rows=True)


# ---------------------------------------------------------------- autoevals


def test_valid_json() -> None:
    assert evals.valid_json('{"a": 1}', {"type": "object", "required": ["a"]})
    assert not evals.valid_json('{"b": 1}', {"type": "object", "required": ["a"]})
    assert not evals.valid_json("not json")


def test_second_opinion_through_router() -> None:
    chat = ScriptedChat([json.dumps({"reasons": "target used as feature", "choice": "C"})])
    res = evals.second_opinion(
        chat,
        code_excerpt="def build_pipeline(p): ...",
        context="ctx",
        critic_verdict="valid",
        critic_provider="groq",
    )
    assert res.verdict == "leak" and "target" in res.rationale
    r = chat.requests[0]
    assert r.alias == "judge" and r.avoid_provider == "groq" and r.privacy is False
    assert r.tool_choice == {"type": "function", "function": {"name": "select_choice"}}
    assert "def build_pipeline" in r.messages[0]["content"] and "valid" in r.messages[0]["content"]
    assert res.step.tool_calls and "disagrees" in res.step.plain


def test_second_opinion_unusable_reply() -> None:
    res = evals.second_opinion(
        ScriptedChat(['{"choice": "Z"}']),
        code_excerpt="c",
        context="x",
        critic_verdict="valid",
        critic_provider=None,
    )
    assert res.verdict is None and res.step.status == "error"


def test_check_numbers() -> None:
    checks = evals.check_numbers(
        {"best_cv": 0.951, "test_score": 0.80, "unknown": 1.0}, {"best_cv": 0.9512, "test_score": 0.95}
    )
    by = {c.key: c for c in checks}
    assert set(by) == {"best_cv", "test_score"}
    assert by["best_cv"].ok and not by["test_score"].ok
