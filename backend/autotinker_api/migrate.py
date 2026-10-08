"""Apply backend/migrations/*.sql to Postgres, in name order, each exactly once.

    uv run --project backend python -m backend.migrate           (from the repo root)
    uv run --project backend python -m backend.migrate --list    (also print the public tables)

Idempotent: applied files are recorded in schema_migrations(name, checksum, applied_at), the same table and checksums
(sha256 of the file) the old web/scripts/db-migrate.mjs wrote, so a database it migrated is picked up as is. A file
whose checksum changed after it was applied is an error (write a new migration instead). Each file runs in one
transaction. Uses DATABASE_URL_UNPOOLED / DATABASE_URL (a direct connection); the URL is never printed.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import sys
from pathlib import Path

from autotinker_api import db, settings

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"
_NAME = re.compile(r"^\d+_[\w-]+\.sql$")


class MigrationError(RuntimeError):
    pass


async def migrate(dsn: str, directory: Path = MIGRATIONS) -> list[str]:
    """Apply pending migrations; returns the names applied."""
    applied: list[str] = []
    async with db.connection(dsn) as conn:
        await conn.execute(
            """create table if not exists schema_migrations (
                 name text primary key, checksum text not null, applied_at timestamptz not null default now())"""
        )
        cur = await conn.execute("select name, checksum from schema_migrations")
        done = {r["name"]: r["checksum"] for r in await cur.fetchall()}
        for path in sorted(p for p in directory.iterdir() if _NAME.match(p.name)):
            sql = path.read_bytes()
            checksum = hashlib.sha256(sql).hexdigest()
            if path.name in done:
                if done[path.name] != checksum:
                    raise MigrationError(f"{path.name} changed after it was applied; add a new migration instead")
                continue
            try:
                async with conn.transaction():
                    await conn.execute(sql.decode())  # a trusted file, many statements
                    await conn.execute(
                        "insert into schema_migrations (name, checksum) values (%s, %s)", (path.name, checksum)
                    )
            except Exception as e:
                raise MigrationError(f"{path.name}: {type(e).__name__}: {e}") from None
            applied.append(path.name)
    return applied


async def tables(dsn: str) -> list[str]:
    async with db.connection(dsn) as conn:
        cur = await conn.execute(
            "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
        )
        return [r["table_name"] for r in await cur.fetchall()]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    settings.load_env_files()
    dsn = settings.migration_database_url()
    if not dsn:
        print("migrate: DATABASE_URL is not set (repo-root .env or the environment).", file=sys.stderr)
        return 1
    try:
        applied = asyncio.run(migrate(dsn))
    except (MigrationError, db.DatabaseUnavailable) as e:
        print(f"migrate: {e}", file=sys.stderr)
        return 1
    for name in applied:
        print(f"applied {name}")
    print(f"{len(applied)} migration(s) applied" if applied else "up to date")
    if "--list" in args:
        print("tables: " + ", ".join(asyncio.run(tables(dsn))))
    return 0
