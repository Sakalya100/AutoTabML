"""Prompts and structured-response parsing for the LLM proposer.

The model sees only: the DataProfile JSON, the user's description, the solution contract, the allowed
imports, the current best code + its dev CV score, a compact ledger summary and (for repair) the error tail.
It never sees select/test scores or raw data files.
"""

from __future__ import annotations

import json
import re
from typing import Any, TypeVar

from pydantic import BaseModel, Field, ValidationError

from autotabml.agent.context import ProposalContext
from autotabml.contracts import IdeaCategory, Metric

# ---------------------------------------------------------------- response schemas


class ProposalOut(BaseModel):
    title: str = Field(min_length=3)
    rationale: str = ""
    category: IdeaCategory
    radical: bool = False
    code: str = Field(min_length=20)


class IdeaOut(BaseModel):
    title: str = Field(min_length=3)
    rationale: str = ""
    category: IdeaCategory
    radical: bool = False


class CodeOut(BaseModel):
    code: str = Field(min_length=20)
    notes: str = ""


T = TypeVar("T", bound=BaseModel)

_FENCE = re.compile(r"```(?:json|JSON)?\s*\n(.*?)```", re.DOTALL)
_PY_FENCE = re.compile(r"```(?:python|py)\s*\n(.*?)```", re.DOTALL)


class ParseError(ValueError):
    pass


def _candidates(text: str) -> list[str]:
    out = [m.group(1) for m in _FENCE.finditer(text)]
    s, e = text.find("{"), text.rfind("}")
    if s != -1 and e > s:
        out.append(text[s : e + 1])
    out.append(text.strip())
    return out


def parse_structured(text: str, model: type[T]) -> T:
    """Parse a JSON object out of an LLM reply. Tolerates ```json fences and surrounding prose; if the
    JSON lacks `code` but the reply has a ```python block, that block is used as the code."""
    errors: list[str] = []
    py = _PY_FENCE.findall(text)
    for cand in _candidates(text):
        try:
            obj: Any = json.loads(cand, strict=False)
        except json.JSONDecodeError as exc:
            errors.append(f"json: {exc}")
            continue
        if not isinstance(obj, dict):
            errors.append("top-level JSON value is not an object")
            continue
        if "code" in model.model_fields and not obj.get("code") and py:
            obj["code"] = py[-1]
        if isinstance(obj.get("category"), str):
            obj["category"] = obj["category"].strip().lower().replace(" ", "_").replace("-", "_")
        try:
            return model.model_validate(obj)
        except ValidationError as exc:
            errors.append(f"schema: {exc.errors()[:3]}")
    raise ParseError("; ".join(errors[-3:]) or "no JSON object found")


# ---------------------------------------------------------------- prompt text

_CATEGORIES = ", ".join(
    c.value for c in IdeaCategory if c not in (IdeaCategory.baseline, IdeaCategory.repair)
)

SYSTEM = """You are AutoTabML, an expert tabular machine-learning engineer running an autonomous
experiment loop.
You improve a single file, solution.py, one idea at a time. A read-only harness fits and scores your code with
repeated k-fold cross-validation inside a sandbox; you never see the data files, only a statistical profile.

Rules:
- solution.py must follow the contract below exactly. All preprocessing and feature engineering must live
  inside the returned (unfitted) estimator/pipeline. Never call fit/predict/score yourself, never read or
  write files, never use the network, never use subprocess.
- Import only from the allowed modules: {allowed}.
- Helper functions used inside the pipeline (e.g. by FunctionTransformer) must be defined at module level.
- Prefer simple, readable code. A change that does not improve the score but adds complexity will be rejected;
  an equally good but simpler solution will be kept.
- Scores are oriented so that higher is better (minimised metrics are negated).

Solution contract:
{contract}
"""

FORMAT_FULL = f"""Reply with ONLY one JSON object, no prose, with these keys:
{{"title": "<one-line statement of the single idea, written before coding>",
  "rationale": "<why it should help, 1-3 sentences>",
  "category": "<one of: {_CATEGORIES}>",
  "radical": <true if this is a different model family, a new approach or an ensemble, else false>,
  "code": "<the COMPLETE new solution.py as a JSON string>"}}"""

FORMAT_IDEA = f"""Reply with ONLY one JSON object, no prose, with these keys:
{{"title": "<one-line statement of the single idea>", "rationale": "<1-3 sentences>",
  "category": "<one of: {_CATEGORIES}>", "radical": <true|false>}}"""

FORMAT_CODE = """Reply with ONLY one JSON object, no prose:
{"code": "<the COMPLETE solution.py as a JSON string>", "notes": "<optional, one line>"}"""


def system_prompt(ctx: ProposalContext) -> str:
    allowed = ", ".join(sorted(ctx.allowed_imports)) or "numpy, pandas, scipy, sklearn"
    return SYSTEM.format(allowed=allowed, contract=ctx.contract_doc.strip() or "(see starter code)")


def _metric_line(ctx: ProposalContext) -> str:
    m: Metric = ctx.profile.metric
    direction = "higher" if m.greater_is_better else "lower"
    return (
        f"Problem: {ctx.profile.problem_type.value}, metric: {m.value} "
        f"({direction} raw is better; scores shown oriented)."
    )


def _profile_block(ctx: ProposalContext) -> str:
    return "Data profile (JSON):\n" + ctx.profile.model_dump_json(indent=1)


def _desc_block(ctx: ProposalContext) -> str:
    return f"User's description of the problem: {ctx.description.strip() or '(none given)'}"


def _best_block(ctx: ProposalContext) -> str:
    score = f"dev CV {ctx.best_cv.mean:.5f} ± {ctx.best_cv.se:.5f} (SE)" if ctx.best_cv else "not scored yet"
    return (
        f"Current best solution ({ctx.best_exp_id or 'starter'}, {score}):\n```python\n{ctx.best_code}\n```"
    )


def draft_messages(ctx: ProposalContext) -> list[dict[str, Any]]:
    starter = f"\nStarter solution for reference:\n```python\n{ctx.best_code}\n```" if ctx.best_code else ""
    text = "\n\n".join(
        [
            _metric_line(ctx),
            _desc_block(ctx),
            _profile_block(ctx),
            "Write a strong first solution.py for this dataset: sensible preprocessing for the column kinds"
            " and"
            " missing values, and a well-suited model. Watch out for columns flagged id_like or"
            " possible_target_leak." + starter,
            'The category "baseline" is reserved; pick the closest other category (usually model_family).',
            FORMAT_FULL,
        ]
    )
    return [{"role": "user", "content": text}]


def _loop_blocks(ctx: ProposalContext) -> list[str]:
    stall = ""
    if ctx.since_last_keep >= 3:
        stall = (
            f"\nNote: the last {ctx.since_last_keep} experiments were not kept. Consider a radical change"
            " (different model family, new feature-engineering approach, or an ensemble)."
        )
    return [
        _metric_line(ctx),
        _desc_block(ctx),
        _profile_block(ctx),
        "Experiment history (do NOT repeat ideas already tried, including discarded ones):\n"
        + ctx.ledger_summary,
        _best_block(ctx) + stall,
    ]


def propose_messages(ctx: ProposalContext) -> list[dict[str, Any]]:
    text = "\n\n".join(
        [
            *_loop_blocks(ctx),
            "Propose ONE new idea likely to improve the dev CV score, state it, then implement it by editing"
            " the"
            " current best solution.",
            FORMAT_FULL,
        ]
    )
    return [{"role": "user", "content": text}]


def idea_only_messages(ctx: ProposalContext) -> list[dict[str, Any]]:
    text = "\n\n".join(
        [*_loop_blocks(ctx), "Propose ONE new idea likely to improve the dev CV score.", FORMAT_IDEA]
    )
    return [{"role": "user", "content": text}]


def implement_messages(ctx: ProposalContext, title: str, rationale: str) -> list[dict[str, Any]]:
    text = "\n\n".join(
        [
            _metric_line(ctx),
            _profile_block(ctx),
            _best_block(ctx),
            "Implement exactly this idea as a minimal edit of the current best solution:\n"
            f"{title}\n{rationale}",
            FORMAT_CODE,
        ]
    )
    return [{"role": "user", "content": text}]


def repair_messages(ctx: ProposalContext, code: str, error_tail: str) -> list[dict[str, Any]]:
    text = "\n\n".join(
        [
            _metric_line(ctx),
            _profile_block(ctx),
            f"This solution.py failed in the harness:\n```python\n{code}\n```",
            f"Last lines of the error output:\n```\n{error_tail.strip()[-4000:]}\n```",
            "Fix the bug with the smallest change that keeps the idea intact. "
            "Return the full corrected file.",
            FORMAT_CODE,
        ]
    )
    return [{"role": "user", "content": text}]


def retry_message(error: str) -> dict[str, Any]:
    return {
        "role": "user",
        "content": f"Your reply could not be parsed ({error[:500]}). Reply again with ONLY the JSON object "
        "described above: valid JSON, code as a single JSON string with escaped newlines and quotes.",
    }
