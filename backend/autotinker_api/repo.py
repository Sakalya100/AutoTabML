"""Queries over the schema in backend/migrations. Every function takes the connection explicitly.

Ownership is enforced by callers through `owned_session` / `owned_run` (a foreign id looks exactly like a missing
one). Wire shapes (`public_meta`, `public_run_row`, ...) are what the web client already consumes.
"""

from __future__ import annotations

import json
import re
import secrets
import string
from datetime import UTC, datetime
from typing import Any

from autotinker_api.db import Conn
from autotinker_api.events import Event, run_patch_from_events

ACTIVE = ("queued", "starting", "running")
TERMINAL = ("finished", "failed", "cancelled", "timed_out")
_ALPHABET = string.ascii_lowercase + string.digits
_SESSION_ID_RE = re.compile(r"^s-[a-z0-9]{6,32}$")
_RUN_ID_RE = re.compile(r"^r-[a-z0-9]{6,32}$")


def _random_id(prefix: str, n: int) -> str:
    return prefix + "".join(secrets.choice(_ALPHABET) for _ in range(n))


def new_session_id() -> str:
    return _random_id("s-", 12)


def new_run_id() -> str:
    return _random_id("r-", 10)


def new_message_id() -> str:
    return _random_id("m-", 14)


def valid_session_id(v: str) -> bool:
    return bool(_SESSION_ID_RE.match(v))


def valid_run_id(v: str) -> bool:
    return bool(_RUN_ID_RE.match(v))


def iso(v: Any) -> str | None:
    """Timestamps as the JS client produced them (toISOString): UTC, milliseconds, trailing Z."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return str(v)


def is_terminal(status: str) -> bool:
    return status in TERMINAL


# ---------------------------------------------------------------------------------------------- owners & sessions


async def ensure_owner(conn: Conn, owner_id: str) -> None:
    await conn.execute("insert into owners (id) values (%s) on conflict (id) do nothing", (owner_id,))


async def create_session(conn: Conn, *, session_id: str, owner_id: str, title: str) -> None:
    await ensure_owner(conn, owner_id)
    await conn.execute(
        "insert into sessions (id, owner_id, title) values (%s, %s, %s)", (session_id, owner_id, title[:120])
    )


async def owned_session(conn: Conn, session_id: str, owner_id: str | None) -> dict[str, Any] | None:
    """The session if `owner_id` owns it, else None (missing and foreign look the same)."""
    if not owner_id or not valid_session_id(session_id):
        return None
    cur = await conn.execute(
        "select id, owner_id, title, created_at, updated_at, last_run_id from sessions where id = %s and owner_id = %s",
        (session_id, owner_id),
    )
    return await cur.fetchone()


async def list_sessions(conn: Conn, owner_id: str, limit: int = 100) -> list[dict[str, Any]]:
    cur = await conn.execute(
        """select s.id, s.title, s.created_at, s.updated_at, s.last_run_id,
                  r.status, r.best, r.metric, r.file_name
             from sessions s left join runs r on r.id = s.last_run_id
            where s.owner_id = %s
            order by s.updated_at desc
            limit %s""",
        (owner_id, limit),
    )
    return [
        {
            "id": r["id"],
            "title": r["title"],
            "createdAt": iso(r["created_at"]),
            "updatedAt": iso(r["updated_at"]),
            "runId": r["last_run_id"],
            "status": r["status"],
            "best": None if r["best"] is None else float(r["best"]),
            "metric": r["metric"],
            "fileName": r["file_name"],
        }
        for r in await cur.fetchall()
    ]


async def rename_session(conn: Conn, session_id: str, owner_id: str, title: str) -> bool:
    cur = await conn.execute(
        "update sessions set title = %s, updated_at = now() where id = %s and owner_id = %s returning id",
        (title, session_id, owner_id),
    )
    return (await cur.fetchone()) is not None


# --------------------------------------------------------------------------------------------------------- runs

# Columns a caller may set through update_run.
_RUN_COLUMNS = {
    "status",
    "error",
    "error_tail",
    "record",
    "runner_ref",
    "ingest_token_sha256",
    "finished_at",
    "deadline_at",
    "last_seen_at",
    "best",
}


async def insert_run(conn: Conn, run: dict[str, Any]) -> None:
    await conn.execute(
        """insert into runs (id, session_id, status, source_url, file_name, target, metric, goal, max_experiments,
                             runner, source, file_bytes, deadline_at, last_seen_at)
           values (%(id)s, %(session_id)s, 'queued', %(source_url)s, %(file_name)s, %(target)s, %(metric)s, %(goal)s,
                   %(max_experiments)s, %(runner)s, %(source)s, %(file_bytes)s, %(deadline_at)s, now())""",
        run,
    )
    await conn.execute(
        "update sessions set last_run_id = %s, updated_at = now() where id = %s", (run["id"], run["session_id"])
    )


async def get_run(conn: Conn, run_id: str) -> dict[str, Any] | None:
    if not valid_run_id(run_id):
        return None
    cur = await conn.execute(
        "select r.*, s.owner_id from runs r join sessions s on s.id = r.session_id where r.id = %s", (run_id,)
    )
    return await cur.fetchone()


async def owned_run(conn: Conn, run_id: str, owner_id: str | None) -> dict[str, Any] | None:
    run = await get_run(conn, run_id)
    return run if run is not None and owner_id and run["owner_id"] == owner_id else None


async def update_run(
    conn: Conn,
    run_id: str,
    *,
    only_if_active: bool = False,
    timings: dict[str, Any] | None = None,
    summary: dict[str, Any] | None = None,
    **fields: Any,
) -> dict[str, Any] | None:
    """Set columns (and merge `timings` / `summary` jsonb). With `only_if_active`, nothing happens to a run that has
    already ended (so a late exit can't overwrite a cancel). Returns the updated row, or None if nothing matched."""
    sets, args = ["updated_at = now()"], []
    for k, v in fields.items():
        if k not in _RUN_COLUMNS:
            raise ValueError(f"unknown run column {k}")
        sets.append(f"{k} = %s" + ("::jsonb" if k == "record" else ""))
        args.append(json.dumps(v) if k == "record" and v is not None else v)
    if timings:
        sets.append("timings = timings || %s::jsonb")
        args.append(json.dumps(timings))
    if summary:
        sets.append("summary = summary || %s::jsonb")
        args.append(json.dumps(summary))
    where = "id = %s" + (" and status in ('queued', 'starting', 'running')" if only_if_active else "")
    cur = await conn.execute(f"update runs set {', '.join(sets)} where {where} returning *", (*args, run_id))
    row = await cur.fetchone()
    if row is not None and "status" in fields:
        await conn.execute("update sessions set updated_at = now() where id = %s", (row["session_id"],))
    return row


async def finish_run(
    conn: Conn, run_id: str, status: str, *, error: str | None = None, error_tail: str | None = None
) -> dict[str, Any] | None:
    """Move an active run to a terminal status (no-op if it has already ended)."""
    return await update_run(
        conn,
        run_id,
        only_if_active=True,
        status=status,
        error=error,
        error_tail=error_tail,
        finished_at=datetime.now(UTC),
    )


async def list_runs(conn: Conn, session_id: str) -> list[dict[str, Any]]:
    cur = await conn.execute("select * from runs where session_id = %s order by created_at", (session_id,))
    return list(await cur.fetchall())


async def active_runs(conn: Conn, limit: int = 50) -> list[dict[str, Any]]:
    cur = await conn.execute(
        "select * from runs where status in ('queued', 'starting', 'running') order by created_at limit %s", (limit,)
    )
    return list(await cur.fetchall())


def public_meta(run: dict[str, Any]) -> dict[str, Any]:
    """What the browser may see about a run (camelCase, as the Next.js API sent it). No tokens or runner refs."""
    out: dict[str, Any] = {
        "id": run["id"],
        "sessionId": run["session_id"],
        "createdAt": iso(run["created_at"]),
        "updatedAt": iso(run["updated_at"]),
        "status": run["status"],
        "runner": run["runner"],
        "engine": "agentic",
        "target": run["target"],
        "description": run["goal"],
        "maxExperiments": run["max_experiments"],
        "source": run["source"],
        "fileName": run["file_name"] or "",
        "fileBytes": int(run["file_bytes"] or 0),
    }
    for key, col in (
        ("metric", "metric"),
        ("sourceUrl", "source_url"),
        ("error", "error"),
        ("errorTail", "error_tail"),
    ):
        if run.get(col):
            out[key] = run[col]
    if run.get("finished_at"):
        out["finishedAt"] = iso(run["finished_at"])
    return out


def public_run_row(run: dict[str, Any]) -> dict[str, Any]:
    """The `row` of a session's run (snake_case, as the Next.js API sent it)."""
    return {
        "id": run["id"],
        "session_id": run["session_id"],
        "status": run["status"],
        "source_url": run["source_url"],
        "file_name": run["file_name"],
        "target": run["target"],
        "metric": run["metric"],
        "goal": run["goal"],
        "max_experiments": run["max_experiments"],
        "created_at": iso(run["created_at"]),
        "finished_at": iso(run["finished_at"]),
        "best": None if run["best"] is None else float(run["best"]),
        "summary": run["summary"] or {},
    }


# ------------------------------------------------------------------------------------------------------- events

INSERT_EVENTS_SQL = """insert into run_events (run_id, seq, type, payload, ts)
  select %s, u.seq, u.type, u.payload::jsonb, u.ts::timestamptz
    from unnest(%s::int[], %s::text[], %s::text[], %s::text[]) as u(seq, type, payload, ts)
  on conflict (run_id, seq) do nothing
  returning seq"""


def _event_ts(ev: Event) -> str:
    ts = ev.get("ts")
    if isinstance(ts, str):
        try:
            datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return ts
        except ValueError:
            pass
    return datetime.now(UTC).isoformat()


async def append_events(conn: Conn, run_id: str, events: list[Event]) -> int:
    """Store events (idempotent on (run_id, seq)), mark the run alive, move it to running, and apply what the events
    change on the run row (best score, summary). Returns how many events were new."""
    if not events:
        return 0
    async with conn.transaction():
        cur = await conn.execute(
            INSERT_EVENTS_SQL,
            (
                run_id,
                [int(e["seq"]) for e in events],
                [str(e["type"]) for e in events],
                [json.dumps(e) for e in events],
                [_event_ts(e) for e in events],
            ),
        )
        fresh = {int(r["seq"]) for r in await cur.fetchall()}
        added = len(fresh)
        # Only events stored just now change the row: a re-delivered batch must not roll the best score back.
        patch = run_patch_from_events(e for e in events if int(e["seq"]) in fresh)
        sets, args = ["last_seen_at = now()"], []
        if "best" in patch:
            sets.append("best = %s")
            args.append(patch["best"])
        if patch.get("summary"):
            sets.append("summary = summary || %s::jsonb")
            args.append(json.dumps(patch["summary"]))
        sets.append(
            "status = case when status in ('queued', 'starting') then 'running' else status end, "
            "updated_at = case when status in ('queued', 'starting') then now() else updated_at end"
        )
        await conn.execute(f"update runs set {', '.join(sets)} where id = %s", (*args, run_id))
    return added


async def touch_seen(conn: Conn, run_id: str) -> None:
    await conn.execute("update runs set last_seen_at = now() where id = %s", (run_id,))


async def read_events(conn: Conn, run_id: str, after: int = -1, limit: int = 10000) -> list[Event]:
    cur = await conn.execute(
        "select payload from run_events where run_id = %s and seq > %s order by seq limit %s", (run_id, after, limit)
    )
    return [r["payload"] for r in await cur.fetchall()]


async def read_events_for_runs(conn: Conn, run_ids: list[str]) -> dict[str, list[Event]]:
    out: dict[str, list[Event]] = {rid: [] for rid in run_ids}
    if not run_ids:
        return out
    cur = await conn.execute(
        "select run_id, payload from run_events where run_id = any(%s) order by run_id, seq", (run_ids,)
    )
    for r in await cur.fetchall():
        out[r["run_id"]].append(r["payload"])
    return out


async def has_event(conn: Conn, run_id: str, event_type: str) -> bool:
    cur = await conn.execute("select 1 from run_events where run_id = %s and type = %s limit 1", (run_id, event_type))
    return (await cur.fetchone()) is not None


# ----------------------------------------------------------------------------------------------------- messages


async def insert_message(
    conn: Conn, *, session_id: str, run_id: str | None, role: str, text: str, kind: str
) -> dict[str, Any]:
    cur = await conn.execute(
        """insert into messages (id, session_id, run_id, role, text, kind) values (%s, %s, %s, %s, %s, %s)
           returning id, session_id, run_id, role, text, kind, created_at""",
        (new_message_id(), session_id, run_id, role, text[:4000], kind),
    )
    row = await cur.fetchone()
    assert row is not None
    await conn.execute("update sessions set updated_at = now() where id = %s", (session_id,))
    return {**row, "created_at": iso(row["created_at"])}


async def list_messages(conn: Conn, session_id: str) -> list[dict[str, Any]]:
    cur = await conn.execute(
        """select id, session_id, run_id, role, text, kind, created_at from messages
            where session_id = %s order by created_at, id""",
        (session_id,),
    )
    return [{**r, "created_at": iso(r["created_at"])} for r in await cur.fetchall()]


# ----------------------------------------------------------------------------------------------------- settings


async def get_setting(conn: Conn, key: str) -> str | None:
    cur = await conn.execute("select value from app_settings where key = %s", (key,))
    row = await cur.fetchone()
    return None if row is None else str(row["value"])


async def set_setting(conn: Conn, key: str, value: str) -> None:
    await conn.execute(
        """insert into app_settings (key, value) values (%s, %s)
           on conflict (key) do update set value = excluded.value, updated_at = now()""",
        (key, value),
    )


async def delete_setting(conn: Conn, key: str) -> None:
    await conn.execute("delete from app_settings where key = %s", (key,))
