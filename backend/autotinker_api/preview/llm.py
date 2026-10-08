"""One small LLM call that refines the heuristic suggestion when the user typed a goal sentence or the heuristics were
unsure. Groq (gpt-oss-120b) first; Gemini flash-lite as a fallback.

Privacy rule (docs/AGENTIC_PLAN.md §12): Gemini's free tier trains on inputs, so it receives ONLY column names and
summary statistics, never data rows. Up to 5 sample rows may go to Groq. Any failure or timeout returns None and the
caller keeps the heuristic suggestion.
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from autotinker_api.preview.csvparse import ColumnStats
from autotinker_api.preview.suggest import PROBLEM_TYPES, Suggestion, metric_fits

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "openai/gpt-oss-120b"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
GEMINI_MODEL = "gemini-3.1-flash-lite"

SYSTEM = """You set up a tabular machine-learning task from a CSV's columns.
Answer with ONE JSON object and nothing else:
{"target": <exact column name to predict>, "problem_type": "binary"|"multiclass"|"regression",
 "metric": "roc_auc"|"log_loss"|"accuracy"|"f1_macro" (classification) or "rmse"|"mae"|"r2" (regression),
 "goal_plain": <one short plain-English sentence for a non-expert>, "why": <at most 20 words>}
Never pick an ID, a free-text or a date column as the target. Prefer what the user's sentence asks for."""


def _js(v: object) -> str:
    return json.dumps(v, ensure_ascii=False)


def describe_columns(stats: list[ColumnStats]) -> str:
    """Column names + stats only. Safe for any provider."""
    lines = []
    for c in stats:
        rng = f" range=[{c['min']}, {c['max']}]" if "min" in c else ""
        lines.append(
            f"- {_js(c['name'])}: {c['kind']}, {c['unique']} distinct, {c['missing']} missing of "
            f"{c['count'] + c['missing']}{rng}"
        )
    return "\n".join(lines)


def build_messages(
    stats: list[ColumnStats], sample: list[list[str]], goal: str, heuristic: Suggestion | None, with_rows: bool
) -> list[dict[str, str]]:
    parts = [f"Columns:\n{describe_columns(stats)}"]
    if with_rows and sample:
        cols = [c["name"] for c in stats]
        rows = [_js({c: (r[i] if i < len(r) else "") for i, c in enumerate(cols)}) for r in sample[:5]]
        parts.append("First rows (JSON):\n" + "\n".join(rows))
    if heuristic:
        parts.append(f"A rule of thumb suggests target={_js(heuristic['target'])} ({heuristic['problemType']}).")
    g = goal.strip()
    parts.append(f"The user says: {_js(g[:500])}" if g else "The user gave no sentence.")
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "\n\n".join(parts)}]


def parse_llm_suggestion(text: str, stats: list[ColumnStats]) -> dict[str, Any] | None:
    """Validate the model's JSON against the columns; drop anything that doesn't fit."""
    m = re.search(r"\{[\s\S]*\}", text)
    try:
        obj = json.loads(m.group(0) if m else text)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    target = obj.get("target")
    if not isinstance(target, str) or not any(c["name"] == target for c in stats):
        return None
    out: dict[str, Any] = {"target": target, "source": "llm"}
    pt = obj.get("problem_type")
    if isinstance(pt, str) and pt in PROBLEM_TYPES:
        out["problemType"] = pt
        metric = obj.get("metric")
        if isinstance(metric, str) and metric_fits(pt, metric):
            out["metric"] = metric
    for key, src in (("goalPlain", "goal_plain"), ("why", "why")):
        v = obj.get(src)
        if isinstance(v, str) and v.strip():
            out[key] = v.strip()[:240]
    return out


async def _call(client: httpx.AsyncClient, url: str, key: str, body: dict[str, Any]) -> str | None:
    try:
        res = await client.post(url, json=body, headers={"Authorization": f"Bearer {key}"})
        if res.status_code >= 400:
            return None
        content = res.json()["choices"][0]["message"]["content"]
        return content if isinstance(content, str) else None
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        return None


async def llm_suggest(
    stats: list[ColumnStats],
    sample: list[list[str]],
    goal: str,
    heuristic: Suggestion | None,
    *,
    groq_key: str | None,
    gemini_key: str | None,
    timeout_s: float = 8.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=timeout_s, transport=transport) as client:
        if groq_key:
            body = {
                "model": GROQ_MODEL,
                "messages": build_messages(stats, sample, goal, heuristic, True),
                "response_format": {"type": "json_object"},
                "temperature": 0.2,
                "max_completion_tokens": 1200,
                "reasoning_effort": "low",
            }
            text = await _call(client, GROQ_URL, groq_key, body)
            parsed = parse_llm_suggestion(text, stats) if text else None
            if parsed:
                return parsed
        if gemini_key:
            body = {
                "model": GEMINI_MODEL,
                "messages": build_messages(stats, sample, goal, heuristic, False),  # no rows to Gemini
                "response_format": {"type": "json_object"},
                "temperature": 0.2,
                "max_tokens": 400,
            }
            text = await _call(client, GEMINI_URL, gemini_key, body)
            parsed = parse_llm_suggestion(text, stats) if text else None
            if parsed:
                return parsed
    return None
