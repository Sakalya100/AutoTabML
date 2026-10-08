"""Run + event storage for the spike: Neon Postgres in deployment, an in-memory store in tests.

Tables are separate from the web app's (`spike_runs`, `spike_run_events`) and created on first use.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any, Protocol

SCHEMA = """
CREATE TABLE IF NOT EXISTS spike_runs (
  id text PRIMARY KEY,
  url text NOT NULL,
  target text NOT NULL,
  max_experiments int NOT NULL,
  status text NOT NULL,
  token_sha256 text NOT NULL,
  sandbox_name text,
  session_id text,
  error text,
  error_tail text,
  exit_code int,
  timings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS spike_run_events (
  run_id text NOT NULL REFERENCES spike_runs(id) ON DELETE CASCADE,
  seq int NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
"""

COLUMNS = (
    "status", "sandbox_name", "session_id", "error", "error_tail", "exit_code",
)


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class Store(Protocol):
    async def create_run(self, run: dict[str, Any]) -> None: ...
    async def update_run(self, run_id: str, timings: dict[str, Any] | None = None, **fields: Any) -> None: ...
    async def get_run(self, run_id: str) -> dict[str, Any] | None: ...
    async def add_events(self, run_id: str, events: list[tuple[int, dict[str, Any]]]) -> int: ...
    async def get_events(self, run_id: str, after: int, limit: int) -> list[dict[str, Any]]: ...


class MemoryStore:
    def __init__(self) -> None:
        self.runs: dict[str, dict[str, Any]] = {}
        self.events: dict[str, dict[int, dict[str, Any]]] = {}

    async def create_run(self, run: dict[str, Any]) -> None:
        self.runs[run["id"]] = {"timings": {}, **{c: None for c in COLUMNS}, **run}
        self.events[run["id"]] = {}

    async def update_run(self, run_id: str, timings: dict[str, Any] | None = None, **fields: Any) -> None:
        r = self.runs[run_id]
        r.update(fields)
        if timings:
            r["timings"] = {**r["timings"], **timings}

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        r = self.runs.get(run_id)
        return dict(r) if r else None

    async def add_events(self, run_id: str, events: list[tuple[int, dict[str, Any]]]) -> int:
        store = self.events[run_id]
        n = 0
        for seq, payload in events:
            if seq not in store:
                store[seq] = payload
                n += 1
        return n

    async def get_events(self, run_id: str, after: int, limit: int) -> list[dict[str, Any]]:
        store = self.events.get(run_id, {})
        return [store[s] for s in sorted(store) if s > after][:limit]


class PostgresStore:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self._ready = False

    async def _conn(self):  # type: ignore[no-untyped-def]
        import psycopg

        # prepare_threshold=None: the pooled Neon endpoint (PgBouncer, transaction mode) can't keep prepared statements
        conn = await psycopg.AsyncConnection.connect(self.dsn, prepare_threshold=None, autocommit=True)
        if not self._ready:
            await conn.execute(SCHEMA)
            self._ready = True
        return conn

    async def create_run(self, run: dict[str, Any]) -> None:
        async with await self._conn() as c:
            await c.execute(
                "INSERT INTO spike_runs (id, url, target, max_experiments, status, token_sha256, timings)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)",
                (run["id"], run["url"], run["target"], run["max_experiments"], run["status"],
                 run["token_sha256"], json.dumps(run.get("timings", {}))),
            )

    async def update_run(self, run_id: str, timings: dict[str, Any] | None = None, **fields: Any) -> None:
        sets, args = ["updated_at = now()"], []
        for k, v in fields.items():
            if k not in COLUMNS:
                raise ValueError(f"unknown column {k}")
            sets.append(f"{k} = %s")
            args.append(v)
        if timings:
            sets.append("timings = timings || %s::jsonb")
            args.append(json.dumps(timings))
        async with await self._conn() as c:
            await c.execute(f"UPDATE spike_runs SET {', '.join(sets)} WHERE id = %s", (*args, run_id))

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        from psycopg.rows import dict_row

        async with await self._conn() as c:
            cur = c.cursor(row_factory=dict_row)
            await cur.execute("SELECT * FROM spike_runs WHERE id = %s", (run_id,))
            row = await cur.fetchone()
        if row is None:
            return None
        for k in ("created_at", "updated_at"):
            row[k] = row[k].isoformat() if row.get(k) else None
        return dict(row)

    async def add_events(self, run_id: str, events: list[tuple[int, dict[str, Any]]]) -> int:
        if not events:
            return 0
        async with await self._conn() as c:
            cur = c.cursor()
            n = 0
            for seq, payload in events:
                await cur.execute(
                    "INSERT INTO spike_run_events (run_id, seq, payload) VALUES (%s, %s, %s::jsonb)"
                    " ON CONFLICT DO NOTHING",
                    (run_id, seq, json.dumps(payload)),
                )
                n += cur.rowcount
        return n

    async def get_events(self, run_id: str, after: int, limit: int) -> list[dict[str, Any]]:
        async with await self._conn() as c:
            cur = await c.execute(
                "SELECT payload FROM spike_run_events WHERE run_id = %s AND seq > %s ORDER BY seq LIMIT %s",
                (run_id, after, limit),
            )
            rows = await cur.fetchall()
        return [r[0] for r in rows]
