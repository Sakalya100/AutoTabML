"""Braintrust `autoevals` in the loop (docs/AGENTIC_PLAN.md §13), pointed at our router.

* `valid_json`        ValidJSON on every structured agent reply (the role runner re-asks once on failure)
* `second_opinion`    LLMClassifier (A valid / B suspicious / C leak) on the Critic's verdict, sent through
                      router with alias `judge` on a provider other than the Critic's
* `check_numbers`     NumericDiff of every number the Reporter quotes against the RunRecord facts

autoevals' own OpenAI client wrapper needs the `openai` SDK; we do not. The classifier is used for what it
owns (prompt rendering, the forced `select_choice` tool schema, response parsing) and the request itself goes
through `ChatBackend.chat`, so it is rate-limited, privacy-filtered and accounted like every other call.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Any

from autoevals import LLMClassifier, NumericDiff, ValidJSON

from autotinker.agent.router import ChatBackend, ChatRequest
from autotinker.contracts import AgentStep

_VALID_JSON = ValidJSON()
_NUMERIC = NumericDiff()


def valid_json(text: str, schema: dict[str, Any] | None = None) -> bool:
    """autoevals ValidJSON. (Called through `valid_json` directly: autoevals 0.3's __call__ drops the
    constructor schema.)"""
    return bool(_VALID_JSON.valid_json(text, schema))


VERDICT_CHOICES = {"A": "valid", "B": "suspicious", "C": "leak"}

JUDGE_PROMPT = """You are auditing one experiment of an automated tabular-ML loop for data leakage and
validity. The harness fits the returned scikit-learn pipeline inside each cross-validation fold and scores it
on held-out rows; the code never sees the test split.

Look for: preprocessing fitted outside the pipeline, features derived from the target, ID-like or
post-outcome columns used as features, use of row order/time that would not exist at prediction time, or a
score jump that is too good to be true.

Context (dataset schema and scores; no data rows):
{{input}}

The solution code (possibly truncated):
```python
{{output}}
```

The first auditor said: {{expected}}

Choose:
A) valid: no leakage or validity problem
B) suspicious: something looks off but is not clearly leakage
C) leak: the score is not trustworthy because of leakage or invalid evaluation"""


@dataclass
class JudgeResult:
    verdict: str | None  # valid | suspicious | leak, None if the judge could not answer
    rationale: str
    step: AgentStep


def make_classifier() -> LLMClassifier:
    return LLMClassifier(
        name="leakage_second_opinion",
        prompt_template=JUDGE_PROMPT,
        choice_scores={"A": 1.0, "B": 0.5, "C": 0.0},
        use_cot=True,
        model="judge",
    )


def second_opinion(
    backend: ChatBackend,
    *,
    code_excerpt: str,
    context: str,
    critic_verdict: str,
    critic_provider: str | None,
    max_tokens: int = 1200,
) -> JudgeResult:
    clf = make_classifier()
    args = clf._build_args(output=code_excerpt, expected=critic_verdict, input=context)
    step = AgentStep(
        step_id=uuid.uuid4().hex[:10],
        role="judge",
        input_summary=f"second opinion on the critic's '{critic_verdict}' verdict (autoevals LLMClassifier)",
    )
    t0 = time.perf_counter()
    try:
        res = backend.chat(
            ChatRequest(
                alias="judge",
                system="You are a careful, skeptical machine-learning auditor.",
                messages=args["messages"],
                tools=args["tools"],
                tool_choice=args["tool_choice"],
                max_tokens=max_tokens,
                role="judge",
                avoid_provider=critic_provider,
            )
        )
    except Exception as exc:
        step.status, step.error = "error", f"{type(exc).__name__}: {exc}"[:1000]
        step.plain = "the second-opinion judge was unavailable"
        step.duration_s = time.perf_counter() - t0
        return JudgeResult(None, step.error, step)
    step.model, step.provider = res.model, res.provider
    step.tokens_in, step.tokens_out = res.usage.tokens_in, res.usage.tokens_out
    step.tokens_cached = res.usage.tokens_cached
    step.cost_usd, step.would_be_cost_usd = res.usage.cost_usd, res.usage.would_be_cost_usd
    step.reasoning = res.reasoning
    step.tool_calls = res.tool_calls
    step.duration_s = time.perf_counter() - t0
    try:
        score = clf._process_response({"tool_calls": res.tool_calls})
        choice = str(score.metadata.get("choice", "")).strip().upper()[:1]
        verdict = VERDICT_CHOICES[choice]
        rationale = str(score.metadata.get("rationale", ""))
    except Exception as exc:
        step.status, step.error = "error", f"unusable judge reply: {exc}"[:1000]
        step.plain = "the second-opinion judge gave an unusable answer"
        return JudgeResult(None, step.error, step)
    step.output = {"verdict": verdict, "rationale": rationale[:2000]}
    agree = "agrees" if verdict == critic_verdict else "disagrees"
    step.plain = f"Second opinion ({res.provider}): {verdict}, {agree} with the critic."
    return JudgeResult(verdict, rationale, step)


@dataclass
class NumberCheck:
    key: str
    quoted: float
    actual: float
    score: float
    ok: bool


def check_numbers(
    quoted: dict[str, float], facts: dict[str, float], *, min_score: float = 0.999
) -> list[NumberCheck]:
    """NumericDiff of every quoted number whose key is a known fact. Unknown keys are ignored."""
    out: list[NumberCheck] = []
    for k, v in quoted.items():
        if k not in facts:
            continue
        actual = float(facts[k])
        try:
            s = float(_NUMERIC(output=float(v), expected=actual).score or 0.0)
        except Exception:
            s = 0.0
        out.append(NumberCheck(k, float(v), actual, s, s >= min_score))
    return out
