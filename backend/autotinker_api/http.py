"""Small HTTP helpers shared by the routers: the error shape the web client expects, the caller's owner id, and the
public base URL the sandbox posts events back to."""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from autotinker_api import settings

NO_STORE = {"Cache-Control": "no-store"}


class ApiError(Exception):
    """Rendered as {"error": message, ...extra} with `status` (the Next.js API's error shape)."""

    def __init__(self, status: int, error: str, headers: dict[str, str] | None = None, **extra: Any) -> None:
        super().__init__(error)
        self.status = status
        self.error = error
        self.extra = extra
        self.headers = headers or {}


def error_response(e: ApiError) -> JSONResponse:
    return JSONResponse({"error": e.error, **e.extra}, status_code=e.status, headers={**NO_STORE, **e.headers})


def json_ok(body: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers=NO_STORE)


def owner_of(request: Request) -> str | None:
    """The caller's owner id (minted by the identity middleware when the cookie was missing)."""
    return getattr(request.state, "owner", None)


def public_base(request: Request) -> str:
    """Where the sandbox reaches this API: AUTOTINKER_PUBLIC_URL, else the host the request came in on."""
    explicit = settings.env("AUTOTINKER_PUBLIC_URL")
    if explicit:
        return explicit.rstrip("/")
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    proto = request.headers.get("x-forwarded-proto") or ("http" if host.startswith(("localhost", "127.")) else "https")
    return f"{proto}://{host}"


async def read_json(request: Request, hint: str) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError:
        raise ApiError(400, hint) from None
    if not isinstance(body, dict):
        raise ApiError(400, hint)
    return body
