"""Runners and configuration: the local runner end to end with a stand-in engine process (events, steering through the
control file, graceful stop, record, cancel), exit-status rules, the sandbox runner's pure parts, secrets hygiene,
and the migrations."""

from __future__ import annotations

import asyncio
import json
import sys
import textwrap
import time
from pathlib import Path
from typing import Any

import pytest
from conftest import run_async

from autotinker_api import db, migrate, repo, settings
from autotinker_api.runners import base, sandbox
from autotinker_api.runners.local import LocalRunner

# Fake credentials, assembled so secret scanners don't flag the source.
FAKE_GROQ = "gsk" + "_testkey12345678"
FAKE_PG = "npg" + "_secret123"

FAKE_ENGINE = textwrap.dedent(
    """
    import json, os, sys, time
    args = sys.argv[1:]
    def opt(name):
        return args[args.index(name) + 1]
    control, out = opt("--control-file"), opt("--out")
    print("not an event", flush=True)
    seq = 0
    def emit(typ, **kw):
        global seq
        print(json.dumps({"seq": seq, "type": typ, "ts": "2026-10-08T10:00:00Z", **kw}), flush=True)
        seq += 1
    emit("run_started", profile={"metric": "roc_auc", "problem_type": "binary", "n_rows": 10})
    seen = 0
    deadline = time.time() + 20
    while time.time() < deadline:
        lines = open(control).read().splitlines()
        for line in lines[seen:]:
            cmd = json.loads(line)
            if cmd["type"] == "steer":
                emit("steer_applied", text=cmd["text"])
            if cmd["type"] == "stop":
                emit("stopped", reason="user", summary="stopped")
                os.makedirs(out, exist_ok=True)
                json.dump({"ok": True}, open(os.path.join(out, "run.json"), "w"))
                emit("run_finished", dev_cv_mean=0.91, n_experiments=1)
                sys.exit(0)
        seen = len(lines)
        if os.environ.get("DATABASE_URL") or os.environ.get("AUTOTINKER_SESSION_SECRET"):
            print("LEAK", file=sys.stderr, flush=True)
            sys.exit(9)
        time.sleep(0.05)
    sys.exit(4)
    """
)


@pytest.fixture()
def engine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, dburl: str) -> Path:
    script = tmp_path / "fake_engine.py"
    script.write_text(FAKE_ENGINE)
    monkeypatch.setenv("AUTOTINKER_PYTHON_CMD", f"{sys.executable} {script}")
    monkeypatch.setenv("AUTOTINKER_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("AUTOTINKER_SESSION_SECRET", "test-secret-0123456789abcdefghijklmnopqrstuvwxyz")
    return script


async def _new_run(conn: db.Conn, run_id: str) -> dict[str, Any]:
    await repo.create_session(conn, session_id="s-test00000000", owner_id="o-test0000000000000000", title="t")
    await repo.insert_run(
        conn,
        {
            "id": run_id,
            "session_id": "s-test00000000",
            "target": "y",
            "metric": None,
            "goal": "",
            "max_experiments": 2,
            "runner": "local",
            "deadline_at": None,
            "source": "url",
            "source_url": "https://data.example/d.csv",
            "file_name": "d.csv",
            "file_bytes": 0,
        },
    )
    run = await repo.get_run(conn, run_id)
    assert run is not None
    return run


async def _wait_for(conn: db.Conn, run_id: str, pred: Any, timeout: float = 15) -> dict[str, Any]:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        run = await repo.get_run(conn, run_id)
        events = await repo.read_events(conn, run_id)
        if run and pred(run, events):
            return run
        await asyncio.sleep(0.05)
    raise AssertionError(f"timed out: {await repo.get_run(conn, run_id)} {await repo.read_events(conn, run_id)}")


def test_local_runner_end_to_end(engine: Path) -> None:
    async def go() -> None:
        runner = LocalRunner()
        async with db.connection() as conn:
            run = await _new_run(conn, "r-local00001")
            await runner.start(base.StartRequest(run=run, csv=None, ingest_url="", ingest_token=""))
            run = await _wait_for(conn, run["id"], lambda r, ev: len(ev) >= 1)
            assert run["status"] == "running" and run["runner_ref"]
            assert await runner.control(run, {"type": "steer", "text": "prefer trees"})
            await _wait_for(conn, run["id"], lambda r, ev: any(e["type"] == "steer_applied" for e in ev))
            assert await runner.control(run, {"type": "stop"})
            done = await _wait_for(conn, run["id"], lambda r, ev: r["status"] == "finished")
            assert done["record"] == {"ok": True} and done["best"] == 0.91
            assert done["summary"]["stop"]["reason"] == "user"
            assert not await runner.control(done, {"type": "stop"})  # process gone

    run_async(go())


def test_local_runner_cancel(engine: Path) -> None:
    async def go() -> None:
        runner = LocalRunner()
        async with db.connection() as conn:
            run = await _new_run(conn, "r-local00002")
            await runner.start(base.StartRequest(run=run, csv=None, ingest_url="", ingest_token=""))
            run = await _wait_for(conn, run["id"], lambda r, ev: len(ev) >= 1)
            assert await runner.cancel(run)
            done = await _wait_for(conn, run["id"], lambda r, ev: r["status"] in repo.TERMINAL)
            assert done["status"] == "cancelled"

    run_async(go())


def test_spawn_failure_is_recorded(dburl: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AUTOTINKER_PYTHON_CMD", str(tmp_path / "no-such-python"))
    monkeypatch.setenv("AUTOTINKER_DATA_DIR", str(tmp_path / "data"))

    async def go() -> None:
        async with db.connection() as conn:
            run = await _new_run(conn, "r-local00003")
            await LocalRunner().start(base.StartRequest(run=run, csv=None, ingest_url="", ingest_token=""))
            row = await repo.get_run(conn, run["id"])
            assert row and row["status"] == "failed" and "Could not start the engine" in row["error"]

    run_async(go())


def test_exit_status_rules() -> None:
    assert base.exit_status(code=0, cancelled=False, has_record=True) == ("finished", None)
    assert base.exit_status(code=3, cancelled=False, has_record=True)[0] == "finished"
    assert base.exit_status(code=3, cancelled=False, has_record=False)[0] == "failed"
    assert base.exit_status(code=-15, cancelled=True, has_record=False)[0] == "cancelled"
    assert base.exit_status(code=0, cancelled=True, has_record=True)[0] == "finished"  # cancel raced a clean exit
    assert base.exit_status(code=None, cancelled=False, has_record=False, spawn_error="ENOENT")[0] == "failed"


def test_engine_args() -> None:
    a = base.engine_args(
        source="https://x.example/d.csv",
        target="y",
        metric="roc_auc",
        goal="predict y",
        max_experiments=5,
        out_dir="/o",
        control_file="/o/c.jsonl",
        max_time_s=2220,
    )
    assert a == [
        "run", "https://x.example/d.csv", "--target", "y", "--metric", "roc_auc", "--goal", "predict y",
        "--max-experiments", "5", "--out", "/o", "--events-stdout",
        "--control-file", "/o/c.jsonl", "--max-time", "2220",
    ]  # fmt: skip
    b = base.engine_args(source="/in.csv", target="y", max_experiments=1, out_dir="/o", control_file="/c")
    assert "--metric" not in b and "--goal" not in b and "--max-time" not in b


def test_sandbox_limits_and_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AUTOTINKER_SANDBOX_MINUTES", raising=False)
    assert sandbox.limit_minutes() == 40 and sandbox.engine_max_time_s() == 37 * 60
    monkeypatch.setenv("AUTOTINKER_SANDBOX_MINUTES", "45")
    assert sandbox.engine_max_time_s() == 42 * 60
    env = {"GROQ_API_KEY": "gsk" + "_real_value_123456", "VERCEL_AUTOMATION_BYPASS_SECRET": "bypass-123"}
    policy = sandbox.run_policy("https://github.com/o/r/blob/main/x.csv", "app.example", env)
    dumped = json.dumps(policy.model_dump(mode="json", by_alias=True)) if hasattr(policy, "model_dump") else str(policy)
    for host in ("github.com", "raw.githubusercontent.com", "app.example", "api.groq.com"):
        assert host in dumped
    assert "generativelanguage" not in dumped
    placeholders = sandbox.engine_env(env)
    assert placeholders == {"GROQ_API_KEY": sandbox.PLACEHOLDER_KEY}
    assert "_real_value" not in json.dumps(placeholders)
    monkeypatch.setenv("AUTOTINKER_SANDBOX_PACKAGE", "autotinker==1")
    k1 = sandbox.snapshot_key()
    monkeypatch.setenv("VERCEL_GIT_COMMIT_SHA", "abc")
    assert sandbox.snapshot_key() != k1


def test_forwarder_script_compiles() -> None:
    compile(sandbox.FORWARD_PY, "forward.py", "exec")
    assert '"$@"' in sandbox.RUN_SH and "--final" in sandbox.RUN_SH


def test_engine_env_never_carries_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    for k, v in {
        "DATABASE_URL": "postgresql://u:" + FAKE_PG + "@h/db",
        "DATABASE_URL_POOLED": "postgresql://u:" + FAKE_PG + "@h-pooler/db",
        "AUTOTINKER_SESSION_SECRET": "x" * 40,
        "VERCEL_AUTOMATION_BYPASS_SECRET": "bypass-secret-1",
        "GROQ_API_KEY": FAKE_GROQ,
        "AUTOTINKER_DISABLED_PROVIDERS": "cerebras",
        "AUTOTINKER_SOME_TOKEN": "t0ken-value-1234",
        "RANDOM_OTHER": "nope",
    }.items():
        monkeypatch.setenv(k, v)
    env = settings.engine_env()
    assert env["GROQ_API_KEY"] == FAKE_GROQ and env["AUTOTINKER_DISABLED_PROVIDERS"] == "cerebras"
    for k in ("DATABASE_URL", "DATABASE_URL_POOLED", "AUTOTINKER_SESSION_SECRET", "VERCEL_AUTOMATION_BYPASS_SECRET"):
        assert env[k] == ""
    assert "AUTOTINKER_SOME_TOKEN" not in env and "RANDOM_OTHER" not in env
    text = "postgresql://u:" + FAKE_PG + "@h/db " + FAKE_GROQ + " Bearer abc.def"
    red = settings.redact(text)
    assert FAKE_PG not in red and FAKE_GROQ not in red and "abc.def" not in red


def test_dotenv_parsing() -> None:
    assert settings.parse_dotenv("# c\nexport A=\"x y\"\nB='z'\nC=plain # note\n\nbad line\n") == {
        "A": "x y",
        "B": "z",
        "C": "plain",
    }


def test_migrations_are_idempotent_and_checksummed(migrated: str, tmp_path: Path) -> None:
    assert run_async(migrate.migrate(migrated)) == []  # already applied by the fixture
    tables = run_async(migrate.tables(migrated))
    for t in (
        "owners",
        "sessions",
        "runs",
        "run_events",
        "messages",
        "schema_migrations",
        "rate_limits",
        "app_settings",
    ):
        assert t in tables
    d = tmp_path / "m"
    d.mkdir()
    for f in migrate.MIGRATIONS.glob("*.sql"):
        (d / f.name).write_bytes(f.read_bytes())
    (d / "001_sessions.sql").write_text("-- edited\n")
    with pytest.raises(migrate.MigrationError, match="changed after it was applied"):
        run_async(migrate.migrate(migrated, d))


def test_migration_001_matches_the_one_already_applied_by_the_web_app() -> None:
    import hashlib

    ours = (migrate.MIGRATIONS / "001_sessions.sql").read_bytes()
    assert hashlib.sha256(ours).hexdigest() == "1a241e38038d501ebd6b3b56fb66e5a8e4d396a9ec4147c57828e55e3d26a694"


def test_env_files_never_mix_databases(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "repo"
    (root / "web").mkdir(parents=True)
    (root / ".env").write_text("DATABASE_URL_POOLED=postgresql://file-pooled/db\nGROQ_API_KEY=from-file-123\n")
    web_env = "AUTOTINKER_SESSION_SECRET=s3cret-from-web-env-local-0123456789\nOTHER=x\n"
    (root / "web" / ".env.local").write_text(web_env)
    monkeypatch.setattr(settings, "REPO_ROOT", root)
    monkeypatch.setattr(settings, "_loaded", False)
    monkeypatch.delenv("AUTOTINKER_NO_DOTENV")
    monkeypatch.delenv("AUTOTINKER_SESSION_SECRET")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("OTHER", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://explicit/db")
    settings.load_env_files()
    assert settings.database_url() == "postgresql://explicit/db"
    assert settings.env("GROQ_API_KEY") == "from-file-123"
    assert settings.env("AUTOTINKER_SESSION_SECRET", "").startswith("s3cret")
    assert settings.env("OTHER") is None  # only the backend's names are taken from web/.env.local
