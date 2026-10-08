"""Clerk sign-in: who the caller is when the deployment has Clerk configured.

Auth mode is "clerk" when a publishable key is set, else "anonymous" (the signed `at_owner` cookie of identity.py,
exactly as before). In clerk mode the owner id is the Clerk user id (`sub`, "user_..."); a signed-out caller has no
owner and the middleware in app.py answers 401 for everything but /api/health, the docs and the engine's ingest.

    CLERK_PUBLISHABLE_KEY      pk_test_... / pk_live_...; turns clerk mode on. NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (the
                               frontend's name for it) is read when this one is unset. The key encodes the Frontend
                               API host (base64 of "<host>$"); its JWKS is https://<host>/.well-known/jwks.json
    CLERK_JWT_KEY              optional PEM public key ("JWT public key" in the Clerk dashboard): verifies without
                               fetching the JWKS. Preferred when set; "\\n" escapes are accepted for one-line envs.
    CLERK_AUTHORIZED_PARTIES   optional comma list of origins a token's `azp` must be one of. Default: the origin of
                               AUTOTINKER_PUBLIC_URL, the origin the request came in on, and http://localhost:3000.

The session token comes from the `__session` cookie (same-origin) or `Authorization: Bearer <token>`. It must be an
RS256 JWT signed by the instance, within exp/nbf (5 s leeway), with an authorized `azp` when it carries one and a
`sub`. Tokens are never logged; a rejected token is just a signed-out request.

Claiming: a browser that used the app anonymously before signing in still sends its `at_owner` cookie. On its first
signed-in request the anonymous owner's sessions (and with them their runs, events and messages) move to the Clerk
user in one transaction, the anonymous owner row is deleted, and the cookie is cleared.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
from urllib.parse import urlsplit

import jwt
from fastapi import Request

from autotinker_api import settings
from autotinker_api.db import Conn

SESSION_COOKIE = "__session"
LEEWAY_S = 5
JWKS_CACHE_S = 3600
DEV_ORIGIN = "http://localhost:3000"

log = logging.getLogger("autotinker.auth")
_warned_malformed = False


class InvalidToken(Exception):
    """The token is missing, malformed, expired, not ours or not for this app (the reason is never shown)."""


@dataclass(frozen=True)
class ClerkConfig:
    frontend_api: str | None  # None: the publishable key is malformed (only CLERK_JWT_KEY can verify then)
    jwt_key: str | None
    authorized_parties: tuple[str, ...] | None  # None: the default list (needs the request)

    @property
    def jwks_url(self) -> str | None:
        return f"https://{self.frontend_api}/.well-known/jwks.json" if self.frontend_api else None


def publishable_key() -> str | None:
    return settings.env("CLERK_PUBLISHABLE_KEY") or settings.env("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")


def frontend_api_from_key(key: str) -> str:
    """pk_test_Zm9vLWJhci0xMi5jbGVyay5hY2NvdW50cy5kZXYk -> foo-bar-12.clerk.accounts.dev"""
    for prefix in ("pk_test_", "pk_live_"):
        if key.startswith(prefix):
            encoded = key[len(prefix) :]
            break
    else:
        raise ValueError("not a Clerk publishable key")
    try:
        host = base64.b64decode(encoded + "=" * (-len(encoded) % 4), validate=True).decode()
    except (binascii.Error, UnicodeDecodeError):
        raise ValueError("not a Clerk publishable key") from None
    host = host.removesuffix("$")
    if not host or "/" in host or any(c.isspace() for c in host):
        raise ValueError("not a Clerk publishable key")
    return host


def config() -> ClerkConfig | None:
    """The Clerk settings, or None in anonymous mode. Read per call (cheap), so tests can switch modes. A malformed
    publishable key still means clerk mode: it fails closed (every request is signed out) rather than open."""
    global _warned_malformed
    key = publishable_key()
    if not key:
        return None
    try:
        frontend_api: str | None = frontend_api_from_key(key)
    except ValueError:
        if not _warned_malformed:
            log.error("clerk: the publishable key is malformed; nobody can sign in")
            _warned_malformed = True
        frontend_api = None
    jwt_key = settings.env("CLERK_JWT_KEY")
    parties = settings.env("CLERK_AUTHORIZED_PARTIES")
    return ClerkConfig(
        frontend_api=frontend_api,
        jwt_key=jwt_key.replace("\\n", "\n") if jwt_key else None,
        authorized_parties=tuple(p.strip().rstrip("/") for p in parties.split(",") if p.strip()) if parties else None,
    )


def mode() -> str:
    return "clerk" if publishable_key() else "anonymous"


def request_origin(request: Request) -> str | None:
    """The origin the browser called (the frontend's, since /api/* is same-origin), as Vercel or the Next dev proxy
    forwarded it. Lets preview deployments work without listing each preview URL."""
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if not host:
        return None
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    return f"{proto.split(',')[0].strip()}://{host.split(',')[0].strip()}"


def _origin(url: str) -> str | None:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else None


def authorized_parties(cfg: ClerkConfig, request_origin: str | None) -> tuple[str, ...]:
    if cfg.authorized_parties is not None:
        return cfg.authorized_parties
    out = [_origin(settings.env("AUTOTINKER_PUBLIC_URL") or ""), request_origin, DEV_ORIGIN]
    return tuple(dict.fromkeys(o for o in out if o))


@lru_cache(maxsize=4)
def _jwks_client(url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(url, cache_keys=True, lifespan=JWKS_CACHE_S, timeout=10)


async def _signing_key(cfg: ClerkConfig, token: str) -> Any:
    if cfg.jwt_key:
        return cfg.jwt_key
    if cfg.jwks_url is None:
        raise InvalidToken
    try:  # PyJWKClient fetches synchronously (only on a cache miss); keep it off the event loop
        return (await asyncio.to_thread(_jwks_client(cfg.jwks_url).get_signing_key_from_jwt, token)).key
    except jwt.PyJWKClientError as e:  # JWKS unreachable, or no key with the token's kid
        log.warning("clerk: no signing key for a session token (%s)", type(e).__name__)
        raise InvalidToken from None


async def verify_token(token: str, cfg: ClerkConfig, parties: tuple[str, ...]) -> str:
    """The Clerk user id (`sub`) of a valid session token; InvalidToken otherwise."""
    try:
        key = await _signing_key(cfg, token)
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            leeway=LEEWAY_S,
            options={"require": ["exp", "sub"], "verify_aud": False},
        )
    except jwt.PyJWTError:
        raise InvalidToken from None
    azp = claims.get("azp")
    if azp and azp.rstrip("/") not in parties:
        raise InvalidToken
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub.startswith("user_") or len(sub) > 128:
        raise InvalidToken
    return sub


def session_token(request: Request) -> str | None:
    """The bearer token if there is one, else the `__session` cookie."""
    header = request.headers.get("authorization") or ""
    scheme, _, value = header.partition(" ")
    if scheme.lower() == "bearer" and value.strip():
        return value.strip()
    return request.cookies.get(SESSION_COOKIE) or None


async def signed_in_user(request: Request, cfg: ClerkConfig, request_origin: str | None) -> str | None:
    """The caller's Clerk user id, or None when signed out (no token, or one that doesn't verify)."""
    token = session_token(request)
    if not token:
        return None
    try:
        return await verify_token(token, cfg, authorized_parties(cfg, request_origin))
    except InvalidToken:
        return None


async def claim_anonymous(conn: Conn, anonymous_owner: str, user_id: str) -> int:
    """Move every session of `anonymous_owner` to `user_id` and drop the anonymous owner. Returns how many sessions
    moved (0 when there was nothing to claim, e.g. it was already claimed)."""
    async with conn.transaction():
        await conn.execute("insert into owners (id) values (%s) on conflict (id) do nothing", (user_id,))
        cur = await conn.execute(
            "update sessions set owner_id = %s where owner_id = %s returning id", (user_id, anonymous_owner)
        )
        moved = len(await cur.fetchall())
        await conn.execute("delete from owners where id = %s", (anonymous_owner,))
    return moved
