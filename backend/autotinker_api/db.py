"""Postgres (Neon) connections.

Driver: psycopg 3, async, one short-lived connection per request (Vercel functions scale to zero and Neon's free tier
limits connections, so nothing is pooled in-process; DATABASE_URL_POOLED points at Neon's PgBouncer, which does the
pooling). `prepare_threshold=None` because PgBouncer in transaction mode can't keep prepared statements.
Long-lived readers (the SSE stream, the local runner's event writer) hold one connection for their lifetime instead
of reconnecting on every poll.

DATABASE_URL_POOLED (or DATABASE_URL) is read server-side only; it is never logged, sent to a browser or passed to
the engine.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row

from autotinker_api import settings

Conn = psycopg.AsyncConnection[dict[str, Any]]


class DatabaseUnavailable(RuntimeError):
    """No database is configured, or it can't be reached right now."""


async def connect(dsn: str | None = None) -> Conn:
    url = dsn or settings.database_url()
    if not url:
        raise DatabaseUnavailable("DATABASE_URL is not set")
    try:
        return await psycopg.AsyncConnection.connect(
            url, autocommit=True, prepare_threshold=None, row_factory=dict_row, connect_timeout=10
        )
    except psycopg.OperationalError as e:
        raise DatabaseUnavailable(f"database unreachable ({type(e).__name__})") from None


@asynccontextmanager
async def connection(dsn: str | None = None) -> AsyncIterator[Conn]:
    conn = await connect(dsn)
    try:
        yield conn
    finally:
        await conn.close()


async def get_conn() -> AsyncIterator[Conn]:
    """FastAPI dependency: a connection for the duration of one request."""
    async with connection() as conn:
        yield conn
