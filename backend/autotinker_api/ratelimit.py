"""Fixed-window rate limits, counted in Postgres so they hold across serverless instances.

    preview     per IP and per owner: AUTOTINKER_PREVIEWS_PER_MIN (default 20) per minute
    run start   per IP:    AUTOTINKER_RUNS_PER_IP_PER_HOUR    (default 3) per hour
                per owner: AUTOTINKER_RUNS_PER_OWNER_PER_HOUR (default 3) per hour

One upsert per key and check (`insert ... on conflict do update set count = count + 1 returning count`), so
concurrent requests can't both slip under the limit. Old windows are swept now and then.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import Request

from autotinker_api import settings
from autotinker_api.db import Conn


@dataclass(frozen=True)
class Limit:
    name: str
    limit: int
    window_s: int


@dataclass(frozen=True)
class Verdict:
    ok: bool
    retry_after_s: int


def preview_limits() -> list[Limit]:
    n = settings.env_int("AUTOTINKER_PREVIEWS_PER_MIN", 20)
    return [Limit("preview:ip", n, 60), Limit("preview:owner", n, 60)]


def run_limits() -> list[Limit]:
    return [
        Limit("run:ip", settings.env_int("AUTOTINKER_RUNS_PER_IP_PER_HOUR", 3), 3600),
        Limit("run:owner", settings.env_int("AUTOTINKER_RUNS_PER_OWNER_PER_HOUR", 3), 3600),
    ]


def client_ip(request: Request) -> str:
    """Vercel sets x-real-ip / x-forwarded-for itself (client-sent values are overwritten); locally, the socket."""
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "local"


async def check(conn: Conn, limits: list[Limit], keys: dict[str, str | None], now: datetime | None = None) -> Verdict:
    """Count one hit against each limit whose key is known (`keys` maps "ip"/"owner" to a value). Denied if any is
    over. A denied hit still counts, so hammering doesn't reset anything."""
    t = now or datetime.now(UTC)
    worst = 0
    ok = True
    for lim in limits:
        who = keys.get(lim.name.split(":", 1)[1])
        if not who or lim.limit <= 0:
            continue
        start_s = int(t.timestamp()) // lim.window_s * lim.window_s
        start = datetime.fromtimestamp(start_s, UTC)
        cur = await conn.execute(
            """insert into rate_limits (key, window_start, count) values (%s, %s, 1)
               on conflict (key, window_start) do update set count = rate_limits.count + 1
               returning count""",
            (f"{lim.name}:{who}", start),
        )
        row = await cur.fetchone()
        count = int(row["count"]) if row else 1
        if count > lim.limit:
            ok = False
            worst = max(worst, int((start + timedelta(seconds=lim.window_s) - t).total_seconds()) + 1)
    if random.random() < 0.02:
        await conn.execute("delete from rate_limits where window_start < now() - interval '1 day'")
    return Verdict(ok, worst)
