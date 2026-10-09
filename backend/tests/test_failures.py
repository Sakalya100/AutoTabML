"""Plain-language failures and the CSV format hand-off: the engine's run_failed event (or a guess from its exit) on
the run meta, csvFormat from the preview to the engine's flags, and uploads in any delimiter/encoding."""

from __future__ import annotations

import asyncio
import json
import sys
import textwrap
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import FakeRunner, run_async
from fastapi.testclient import TestClient

from autotinker_api import db, failures, repo, validation
from autotinker_api.preview.service import build_preview
from autotinker_api.runners import base
from autotinker_api.runners.local import LocalRunner

PUBLIC_IP = "93.184.216.34"


@pytest.fixture(autouse=True)
def public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    import autotinker_api.urlguard as guard

    monkeypatch.setattr(guard, "system_resolve", lambda host: [PUBLIC_IP])


# ------------------------------------------------------------------------------------------------------ mapping


def test_event_wins_and_is_sanitised() -> None:
    ev = {"type": "run_failed", "code": "target_missing", "message": 'The column "qualty"\nisn\'t here.', "hint": "x"}
    f = failures.describe(ev, code=2, tail="Traceback ... MemoryError")
    assert f == failures.Failure("target_missing", 'The column "qualty" isn\'t here.', "x")
    assert failures.from_event({**ev, "code": "made_up"}) == failures.Failure("unexpected", f.message, "x")
    assert failures.from_event({"type": "run_failed", "code": "x", "message": ""}) is None


@pytest.mark.parametrize(
    ("code", "tail", "timed_out", "expected"),
    [
        (-9, "", True, "out_of_time"),
        (-9, "", False, "out_of_memory"),
        (137, "", False, "out_of_memory"),
        (1, "MemoryError: Unable to allocate 2.1 GiB", False, "out_of_memory"),
        (2, "error: target column 'quality' not found; columns: ['a;b']", False, "target_missing"),
        (2, "error: the server answered HTTP 404 for https://x", False, "download_failed"),
        (2, "error: the link returned a web page, not a data file", False, "not_csv"),
        (2, "no LLM provider is configured: set GROQ_API_KEY", False, "llm_unavailable"),
        (2, "Error: No such option: --delimiter", False, "unexpected"),
        (1, "ZeroDivisionError: division by zero", False, "unexpected"),
        (None, "", False, "unexpected"),
    ],
)
def test_exit_mapping(code: int | None, tail: str, timed_out: bool, expected: str) -> None:
    f = failures.describe(None, code=code, tail=tail, timed_out=timed_out)
    assert f.code == expected and f.message and f.hint
    assert "Traceback" not in f.message


def test_engine_args_carry_the_csv_format() -> None:
    args = base.engine_args(
        source="https://x/w.csv",
        target="quality",
        max_experiments=2,
        out_dir="/o",
        control_file="/c",
        csv_format={"delimiter": ";", "encoding": "utf-8", "decimal": "."},
    )
    assert args[args.index("--delimiter") + 1] == ";"
    assert args[args.index("--encoding") + 1] == "utf-8"
    assert args[args.index("--decimal") + 1] == "."
    tab = base.engine_args(
        source="s", target="t", max_experiments=1, out_dir="/o", control_file="/c", csv_format={"delimiter": "\t"}
    )
    assert tab[tab.index("--delimiter") + 1] == "tab" and "--encoding" not in tab
    plain = base.engine_args(source="s", target="t", max_experiments=1, out_dir="/o", control_file="/c")
    assert "--delimiter" not in plain


def test_csv_format_validation_and_upload_detection() -> None:
    assert validation.validate_csv_format({"delimiter": ";", "encoding": "UTF-8", "decimal": ","}) == {
        "delimiter": ";",
        "encoding": "utf-8",
        "decimal": ",",
    }
    assert validation.validate_csv_format({"delimiter": "x", "encoding": "ebcdic"}) is None
    assert validation.validate_csv_format("nope") is None
    latin = ("ciudad;precio\n" + "".join(f"Málaga;{i},5\n" for i in range(25))).encode("latin-1")
    assert validation.detect_csv_format(latin) == {"delimiter": ";", "encoding": "cp1252", "decimal": ","}
    assert validation.validate_upload(file_name="d.csv", data=latin) == ["ciudad", "precio"]
    bom = b"\xef\xbb\xbfa\tb\n" + b"".join(b"%d\t%d\n" % (i, i) for i in range(25))
    assert validation.detect_csv_format(bom)["encoding"] == "utf-8-sig"
    assert validation.validate_upload(file_name="d.csv", data=bom) == ["a", "b"]


def test_preview_reports_the_format() -> None:
    from test_preview import RESOLVE

    wine = '"fixed acidity";"pH";"quality"\n' + "".join(f"7.4;3.5{i % 10};{5 + i % 3}\n" for i in range(40))
    euro = "Länge;Klasse\n" + "".join(f"{i},5;{i % 2}\n" for i in range(40))

    def serve(body: bytes) -> httpx.MockTransport:
        return httpx.MockTransport(lambda req: httpx.Response(200, content=body, headers={"content-type": "text/csv"}))

    p = asyncio.run(build_preview("https://a.example/w.csv", resolver=RESOLVE, transport=serve(wine.encode())))
    assert (p["delimiter"], p["encoding"], p["decimal"]) == (";", "utf-8", ".")
    assert p["columns"] == ["fixed acidity", "pH", "quality"]
    p = asyncio.run(build_preview("https://a.example/e.csv", resolver=RESOLVE, transport=serve(euro.encode("cp1252"))))
    assert (p["delimiter"], p["encoding"], p["decimal"]) == (";", "cp1252", ",")
    assert p["columns"] == ["Länge", "Klasse"]


# ----------------------------------------------------------------------------------------------------------- API


def _token(fake: FakeRunner, run_id: str) -> str:
    return next(r.ingest_token for r in fake.started if r.run["id"] == run_id)


def test_csv_format_is_stored_and_reaches_the_runner(client: TestClient, fake_runner: FakeRunner) -> None:
    fmt = {"delimiter": ";", "encoding": "utf-8", "decimal": "."}
    body = {"url": "https://data.example/winequality-red.csv", "target": "quality", "maxExperiments": 2}
    r = client.post("/api/runs", json={**body, "csvFormat": fmt})
    assert r.status_code == 201, r.text
    meta = r.json()["meta"]
    assert meta["csvFormat"] == fmt
    assert (meta["sourceUrl"], meta["target"], meta["maxExperiments"]) == (body["url"], "quality", 2)
    assert fake_runner.started[0].run["csv_format"] == fmt
    # Without one, nothing is passed and the engine detects the format itself.
    r = client.post("/api/runs", json=body)
    assert "csvFormat" not in r.json()["meta"] and fake_runner.started[1].run["csv_format"] is None


def test_semicolon_upload_is_accepted_with_its_format(client: TestClient, fake_runner: FakeRunner) -> None:
    csv = "a;b;y\n" + "".join(f"{i};{i},5;{i % 2}\n" for i in range(30))
    r = client.post(
        "/api/runs", data={"target": "y", "maxExperiments": "2"}, files={"file": ("d.csv", csv.encode(), "text/csv")}
    )
    assert r.status_code == 201, r.text
    assert r.json()["meta"]["csvFormat"] == {"delimiter": ";", "encoding": "utf-8", "decimal": ","}


def test_sandbox_exit_uses_the_engines_failure(client: TestClient, fake_runner: FakeRunner) -> None:
    body = {"url": "https://data.example/w.csv", "target": "qualty", "maxExperiments": 2}
    run_id = client.post("/api/runs", json=body).json()["id"]
    hdr = {"X-Ingest-Token": _token(fake_runner, run_id)}
    failed = {
        "run_id": "",
        "seq": 1,
        "type": "run_failed",
        "code": "target_missing",
        "message": 'The column "qualty" isn\'t in this file.',
        "hint": 'Did you mean "quality"?',
    }
    lines = [json.dumps(failed)]
    assert client.post(f"/api/runs/{run_id}/ingest", json={"kind": "events", "lines": lines}, headers=hdr).json()["ok"]
    client.post(f"/api/runs/{run_id}/ingest", json={"kind": "exit", "exit_code": 2, "stderr_tail": "x"}, headers=hdr)
    meta = client.get(f"/api/runs/{run_id}").json()["meta"]
    assert meta["status"] == "failed" and meta["errorCode"] == "target_missing"
    assert meta["error"] == failed["message"] and meta["hint"] == failed["hint"]


def test_sandbox_exit_without_an_event_is_guessed(client: TestClient, fake_runner: FakeRunner) -> None:
    run_id = client.post("/api/runs", json={"url": "https://data.example/w.csv", "target": "y"}).json()["id"]
    hdr = {"X-Ingest-Token": _token(fake_runner, run_id)}
    client.post(f"/api/runs/{run_id}/ingest", json={"kind": "exit", "exit_code": 137, "stderr_tail": ""}, headers=hdr)
    meta = client.get(f"/api/runs/{run_id}").json()["meta"]
    assert meta["status"] == "failed" and meta["errorCode"] == "out_of_memory" and meta["hint"]


# ------------------------------------------------------------------------------------------------- local runner

FAILING_ENGINE = textwrap.dedent(
    """
    import json, sys
    args = sys.argv[1:]
    print(json.dumps({"seq": 1, "type": "run_failed", "run_id": "", "code": "target_missing",
                      "message": "The column isn't in this file.", "hint": "Did you mean quality?",
                      "argv": args}), flush=True)
    print("error: target column 'qualty' not found", file=sys.stderr)
    sys.exit(2)
    """
)


def test_local_runner_records_the_engines_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, dburl: str) -> None:
    script = tmp_path / "engine.py"
    script.write_text(FAILING_ENGINE)
    monkeypatch.setenv("AUTOTINKER_PYTHON_CMD", f"{sys.executable} {script}")
    monkeypatch.setenv("AUTOTINKER_DATA_DIR", str(tmp_path / "data"))

    async def go() -> None:
        async with db.connection() as conn:
            await repo.create_session(conn, session_id="s-fail0000000", owner_id="o-test0000000000000000", title="t")
            await repo.insert_run(
                conn,
                {
                    "id": "r-fail000001",
                    "session_id": "s-fail0000000",
                    "target": "qualty",
                    "metric": None,
                    "goal": "",
                    "max_experiments": 2,
                    "runner": "local",
                    "deadline_at": None,
                    "source": "url",
                    "source_url": "https://data.example/w.csv",
                    "file_name": "w.csv",
                    "file_bytes": 0,
                    "csv_format": {"delimiter": ";", "encoding": "utf-8", "decimal": "."},
                },
            )
            run = await repo.get_run(conn, "r-fail000001")
            assert run is not None
            await LocalRunner().start(base.StartRequest(run=run, csv=None, ingest_url="", ingest_token=""))
            end = time.monotonic() + 15
            while time.monotonic() < end:
                run = await repo.get_run(conn, "r-fail000001")
                if run and run["status"] == "failed":
                    break
                await asyncio.sleep(0.05)
            assert run is not None and run["status"] == "failed"
            meta: dict[str, Any] = repo.public_meta(run)
            assert meta["errorCode"] == "target_missing" and meta["hint"] == "Did you mean quality?"
            assert meta["error"] == "The column isn't in this file."
            (ev,) = await repo.read_events(conn, "r-fail000001")
            argv = ev["argv"]
            assert argv[argv.index("--delimiter") + 1] == ";" and argv[argv.index("--decimal") + 1] == "."

    run_async(go())
