"""Test fixtures: a throwaway Postgres (TEST_DATABASE_URL, or a temporary local cluster via initdb), migrated once and
truncated between tests; a fake runner; and two "browsers" (TestClients with separate cookie jars).

Nothing here reads the repo's .env files (AUTOTINKER_NO_DOTENV=1), so no real key or database is ever touched.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

os.environ["AUTOTINKER_NO_DOTENV"] = "1"
os.environ["AUTOTINKER_SESSION_SECRET"] = "test-secret-0123456789abcdefghijklmnopqrstuvwxyz"
os.environ["AUTOTINKER_RUNNER"] = "local"
for _k in (
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "CEREBRAS_API_KEY",
    "DATABASE_URL_POOLED",
    "VERCEL",
    "CLERK_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "CLERK_JWT_KEY",
    "CLERK_AUTHORIZED_PARTIES",
    "AUTOTINKER_PUBLIC_URL",
):
    os.environ.pop(_k, None)

from fastapi.testclient import TestClient  # noqa: E402

from autotinker_api import background, db, migrate  # noqa: E402
from autotinker_api.runners import set_runner_for_tests  # noqa: E402
from autotinker_api.runners.base import ControlCommand, StartRequest  # noqa: E402


def _pg_bin(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for base in ("/opt/homebrew/opt", "/usr/local/opt"):
        for d in sorted(Path(base).glob("postgresql*/bin"), reverse=True):
            if (d / name).exists():
                return str(d / name)
    for d in sorted(Path("/usr/lib/postgresql").glob("*/bin"), reverse=True):
        if (d / name).exists():
            return str(d / name)
    return None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    explicit = os.environ.get("TEST_DATABASE_URL")
    if explicit:
        yield explicit
        return
    initdb, pg_ctl = _pg_bin("initdb"), _pg_bin("pg_ctl")
    if not initdb or not pg_ctl:
        pytest.skip("no Postgres: set TEST_DATABASE_URL or install postgres (initdb, pg_ctl)")
    tmp = Path(tempfile.mkdtemp(prefix="at-pg-"))
    data, port = tmp / "data", _free_port()
    subprocess.run(
        [initdb, "-D", str(data), "-U", "test", "--auth=trust", "-E", "UTF8"], check=True, capture_output=True
    )
    subprocess.run(
        [
            pg_ctl,
            "-D",
            str(data),
            "-o",
            f"-p {port} -k {tmp} -c listen_addresses=127.0.0.1",
            "-l",
            str(tmp / "log"),
            "start",
        ],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"postgresql://test@127.0.0.1:{port}/postgres"
    for _ in range(50):
        try:
            asyncio.run(_ping(url))
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.1)
    try:
        yield url
    finally:
        subprocess.run(
            [pg_ctl, "-D", str(data), "-m", "immediate", "stop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        shutil.rmtree(tmp, ignore_errors=True)


async def _ping(url: str) -> None:
    async with db.connection(url) as conn:
        await conn.execute("select 1")


async def _reset(url: str) -> None:
    async with db.connection(url) as conn:
        await conn.execute("truncate owners, sessions, runs, run_events, messages, rate_limits, app_settings cascade")


@pytest.fixture(scope="session")
def migrated(database_url: str) -> str:
    asyncio.run(migrate.migrate(database_url))
    return database_url


@pytest.fixture()
def dburl(migrated: str, monkeypatch: pytest.MonkeyPatch) -> str:
    asyncio.run(_reset(migrated))
    monkeypatch.setenv("DATABASE_URL", migrated)
    return migrated


class FakeRunner:
    """Records calls; `deliver` controls whether control commands reach the 'engine'."""

    kind = "local"

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.deliver = True
        self.started: list[StartRequest] = []

    async def start(self, req: StartRequest) -> None:
        self.calls.append(("start", req.run["id"]))
        self.started.append(req)

    async def control(self, run: dict[str, Any], cmd: ControlCommand) -> bool:
        self.calls.append(("control", cmd))
        return self.deliver

    async def cancel(self, run: dict[str, Any]) -> bool:
        self.calls.append(("cancel", run["id"]))
        return True


@pytest.fixture()
def fake_runner() -> Iterator[FakeRunner]:
    r = FakeRunner()
    set_runner_for_tests("local", r)
    set_runner_for_tests("sandbox", r)
    yield r
    set_runner_for_tests("local", None)
    set_runner_for_tests("sandbox", None)


@pytest.fixture()
def app(dburl: str, fake_runner: FakeRunner) -> Any:
    from autotinker_api.app import app as fastapi_app

    return fastapi_app


@pytest.fixture()
def client(app: Any) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def other(app: Any) -> Iterator[TestClient]:
    """A second browser (its own cookie jar)."""
    with TestClient(app) as c:
        yield c


def run_async(coro: Any) -> Any:
    return asyncio.run(coro)


async def drain() -> None:
    await background.drain()
