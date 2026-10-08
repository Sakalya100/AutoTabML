"""POST /api/preview: preview a public CSV link and suggest what to predict."""

from __future__ import annotations

import logging
import time
from collections import defaultdict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from autotinker_api import db, ratelimit, settings
from autotinker_api.http import ApiError, json_ok, owner_of, read_json
from autotinker_api.preview.service import PreviewError, cached_preview, suggest_for

router = APIRouter()
log = logging.getLogger("autotinker.preview")

MAX_URL = 2048
MAX_GOAL = 500
_fallback_hits: dict[str, list[float]] = defaultdict(list)


def _fallback_ok(key: str, limit: int) -> bool:
    """Per-instance limiter for when the database (and with it the shared counters) is unavailable."""
    now = time.monotonic()
    hits = [t for t in _fallback_hits[key] if now - t < 60]
    ok = len(hits) < limit
    if ok:
        hits.append(now)
    _fallback_hits[key] = hits
    return ok


@router.post("/api/preview")
async def preview(request: Request) -> JSONResponse:
    """Body {url, goal?}. Returns the header, inferred column kinds, a ≤ 50-row sample (for display only), the row
    count (exact or estimated), the direct download URL and suggestions for target / problem type / metric."""
    body = await read_json(request, "Send JSON: {url, goal?}.")
    raw_url, raw_goal = body.get("url"), body.get("goal")
    url = raw_url.strip() if isinstance(raw_url, str) else ""
    goal = raw_goal.strip()[:MAX_GOAL] if isinstance(raw_goal, str) else ""
    if not url:
        raise ApiError(400, "Paste a link to a CSV file.", field="url", code="invalid_url")
    if len(url) > MAX_URL:
        raise ApiError(400, "That link is too long.", field="url", code="invalid_url")

    ip = ratelimit.client_ip(request)
    try:
        async with db.connection() as conn:
            verdict = await ratelimit.check(conn, ratelimit.preview_limits(), {"ip": ip, "owner": owner_of(request)})
        ok, retry = verdict.ok, verdict.retry_after_s
    except db.DatabaseUnavailable:
        ok, retry = _fallback_ok(ip, settings.env_int("AUTOTINKER_PREVIEWS_PER_MIN", 20)), 60
    if not ok:
        raise ApiError(
            429,
            f"Too many previews in a minute. Try again in {retry} s.",
            headers={"Retry-After": str(retry)},
            code="rate_limited",
        )

    try:
        p = await cached_preview(url)
        suggestion, llm = await suggest_for(
            p, goal, groq_key=settings.env("GROQ_API_KEY"), gemini_key=settings.env("GEMINI_API_KEY")
        )
    except PreviewError as e:
        raise ApiError(422, e.message, field="url", code=e.code) from None
    except Exception as e:  # noqa: BLE001
        log.error("preview failed unexpectedly: %s", type(e).__name__)
        raise ApiError(
            500,
            "Something went wrong reading that link. Try again, or upload the file instead.",
            field="url",
            code="internal",
        ) from None
    return json_ok({"preview": p, "suggestion": suggestion, "llm": llm})
