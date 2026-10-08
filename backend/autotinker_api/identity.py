"""Anonymous identity: one signed, httpOnly cookie per browser holds an owner id.

    cookie  at_owner = <ownerId>.<base64url(HMAC-SHA256(secret, "owner:" + ownerId)), no padding>

Same name, format and secret (AUTOTINKER_SESSION_SECRET) as the Next.js backend it replaces, so existing browser
sessions keep working. The secret is server-only: never logged, never sent to the browser or the engine.
The middleware in app.py mints the cookie on the first API request that lacks a valid one.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import secrets

from autotinker_api import settings

OWNER_COOKIE = "at_owner"
ONE_YEAR_S = 60 * 60 * 24 * 365
_OWNER_RE = re.compile(r"^o-[A-Za-z0-9_-]{16,64}$")

log = logging.getLogger("autotinker.identity")
_ephemeral: str | None = None


def session_secret() -> str:
    """The signing secret. Without one (misconfigured dev), a per-process random one: identities reset on restart."""
    global _ephemeral
    s = settings.env("AUTOTINKER_SESSION_SECRET")
    if s and len(s) >= 32:
        return s
    if settings.on_vercel():
        raise RuntimeError("AUTOTINKER_SESSION_SECRET is not set")
    if _ephemeral is None:
        log.warning("AUTOTINKER_SESSION_SECRET is not set; using a temporary secret (sessions reset on restart)")
        _ephemeral = base64.b64encode(secrets.token_bytes(32)).decode()
    return _ephemeral


def _mac(owner_id: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), f"owner:{owner_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def new_owner_id() -> str:
    return "o-" + base64.urlsafe_b64encode(secrets.token_bytes(18)).rstrip(b"=").decode()


def sign_owner(owner_id: str, secret: str | None = None) -> str:
    return f"{owner_id}.{_mac(owner_id, secret or session_secret())}"


def verify_owner(value: str | None, secret: str | None = None) -> str | None:
    """The owner id in a cookie value, or None if it is malformed or the signature doesn't match."""
    if not value:
        return None
    dot = value.rfind(".")
    if dot <= 0:
        return None
    owner_id, sig = value[:dot], value[dot + 1 :]
    if not _OWNER_RE.match(owner_id):
        return None
    want = _mac(owner_id, secret or session_secret())
    return owner_id if hmac.compare_digest(sig.encode(), want.encode()) else None
