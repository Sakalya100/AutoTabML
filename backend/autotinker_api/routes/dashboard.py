"""The caller's dashboard: runs, experiments, tokens and model quality over the last `days` days (7-90, default 30)."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from autotinker_api import dashboard, db
from autotinker_api.http import ApiError, json_ok, owner_of

router = APIRouter()


@router.get("/api/dashboard")
async def get_dashboard(request: Request) -> JSONResponse:
    raw = request.query_params.get("days")
    try:
        days = dashboard.DEFAULT_DAYS if raw in (None, "") else int(raw)
    except ValueError:
        raise ApiError(400, "days must be a whole number of days (7 to 90).", field="days") from None
    days = dashboard.clamp_days(days)
    owner = owner_of(request)
    if not owner:
        raise ApiError(401, "Sign in to see your dashboard.", code="auth_required")
    async with db.connection() as conn:
        return json_ok(await dashboard.build(conn, owner, days))
