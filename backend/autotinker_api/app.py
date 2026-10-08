"""The FastAPI app: identity middleware (anonymous cookie or Clerk, see auth.py), error shapes and the routers. Served
as `main:app` (backend/main.py)."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from autotinker_api import auth, db, identity, settings
from autotinker_api.http import ApiError, error_response, json_ok
from autotinker_api.routes import preview, runs, sessions

settings.load_env_files()
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

app = FastAPI(title="autotinker", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)


_DOCS_PATHS = ("/api/docs", "/api/openapi.json")


def _wants_identity(path: str) -> bool:
    return path.startswith("/api/") and not path.endswith("/ingest") and path != "/api/health"


def _sign_in_message(request: Request) -> str:
    starts = request.method == "POST" and request.url.path in ("/api/runs", "/api/preview")
    return "Sign in to start a run." if starts else "Sign in to see your sessions."


async def _claim(anonymous_owner: str, user_id: str) -> bool:
    """Move an anonymous browser's sessions to the user who just signed in on it. True once the cookie is spent
    (claimed now or nothing left to claim); False if the database can't be reached (try again next request)."""
    try:
        async with db.connection() as conn:
            moved = await auth.claim_anonymous(conn, anonymous_owner, user_id)
    except db.DatabaseUnavailable:
        return False
    if moved:
        logging.getLogger("autotinker.auth").info("claimed %d anonymous session(s) for a signed-in user", moved)
    return True


@app.middleware("http")
async def request_context(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    try:  # the Sandbox SDK reads the per-request OIDC token (x-vercel-oidc-token) from this context
        from vercel.headers import set_headers

        set_headers(dict(request.headers))
    except ImportError:  # pragma: no cover
        pass
    minted: str | None = None
    owner: str | None = None
    spent_cookie = False
    clerk = auth.config()
    if _wants_identity(request.url.path) and clerk is not None and request.url.path not in _DOCS_PATHS:
        # Clerk: the owner is the signed-in user; signed-out callers get nothing but /api/health and the docs.
        owner = await auth.signed_in_user(request, clerk, auth.request_origin(request))
        if owner is None:
            return error_response(ApiError(401, _sign_in_message(request), code="auth_required"))
        anonymous = identity.verify_owner(request.cookies.get(identity.OWNER_COOKIE))
        if anonymous is not None:
            spent_cookie = await _claim(anonymous, owner)
    elif _wants_identity(request.url.path) and clerk is None:
        # The anonymous owner cookie: minted on the first API call without a valid one (the sessions list, which the
        # workspace loads first), so later calls in the same browser all see the same owner.
        owner = identity.verify_owner(request.cookies.get(identity.OWNER_COOKIE))
        if owner is None:
            owner = identity.new_owner_id()
            minted = identity.sign_owner(owner)
    request.state.owner = owner
    response = await call_next(request)
    secure = settings.on_vercel() or request.url.scheme == "https"
    if minted:
        response.set_cookie(
            identity.OWNER_COOKIE,
            minted,
            max_age=identity.ONE_YEAR_S,
            path="/",
            httponly=True,
            samesite="lax",
            secure=secure,
        )
    elif spent_cookie:
        response.delete_cookie(identity.OWNER_COOKIE, path="/", httponly=True, samesite="lax", secure=secure)
    return response


@app.exception_handler(ApiError)
async def api_error(_: Request, e: ApiError) -> JSONResponse:
    return error_response(e)


@app.exception_handler(db.DatabaseUnavailable)
async def db_unavailable(_: Request, e: db.DatabaseUnavailable) -> JSONResponse:
    logging.getLogger("autotinker.db").warning("database unavailable: %s", e)
    return error_response(ApiError(503, "Saved sessions are unavailable right now. Try again in a minute."))


@app.get("/api/health")
async def health() -> JSONResponse:
    return json_ok(
        {
            "ok": True,
            "auth": auth.mode(),
            "runner": settings.runner_kind(),
            "liveRuns": settings.live_runs_enabled(),
            "database": bool(settings.database_url()),
        }
    )


app.include_router(sessions.router)
app.include_router(runs.router)
app.include_router(preview.router)
