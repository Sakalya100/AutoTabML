"""Reply builders for ScriptedChat-driven agentic tests."""

from __future__ import annotations

import json


def plan(title: str, family: str = "random_forest", cat: str = "model_family", radical: bool = False) -> str:
    return json.dumps(
        {
            "title": title,
            "block": "model",
            "rationale": "because",
            "category": cat,
            "family": family,
            "radical": radical,
            "plain": f"Try {title}.",
        }
    )


def fake_code(score: float | None, *, crash: bool = False, tag: str = "") -> str:
    body = "    return 'x'"
    if crash:
        body += "  # CRASH"
    if score is not None:
        body += f"  # fake-score: {score}"
    return f"def build_pipeline(profile):\n{body}\n    # {tag}\n"


def code_reply(code: str, plain: str = "Changed the model.") -> str:
    return f"{plain}\n```python\n{code}```\n"


def critic(verdict: str = "valid", learned: str = "it helped") -> str:
    return json.dumps({"verdict": verdict, "reasons": "r", "learned": learned, "plain": "Looks fine."})


def judge(choice: str = "A") -> str:
    return json.dumps({"reasons": "checked", "choice": choice})


PROFILER = json.dumps(
    {
        "story": "small clean data",
        "risks": ["few rows"],
        "drop_columns": [],
        "split_advice": "",
        "plain": "ok",
    }
)


def reporter(numbers: dict[str, float] | None = None) -> str:
    return json.dumps(
        {
            "summary": "The run found a good model.",
            "what_worked": ["trees"],
            "caveats": ["small data"],
            "next_steps": ["more data"],
            "numbers": numbers or {},
            "plain": "We found a good model.",
        }
    )
