"""Credential-free checks: ingest token, event storage/ordering/dedup, stop wiring, policy construction."""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

import main
from runner import FORWARD_PY, PLACEHOLDER_KEY, StartResult, dataset_hosts, engine_env, run_policy
from store import MemoryStore


class FakeRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.token = ""
        self.ingest_url = ""

    async def start(self, **kw: Any) -> StartResult:
        self.calls.append(("start", kw))
        self.token, self.ingest_url = kw["token"], kw["ingest_url"]
        return StartResult("autotinker-spike-x", "sbx_1", 1.0, 10.0, 0.5)

    async def request_stop(self, name: str) -> None:
        self.calls.append(("request_stop", name))

    async def cancel(self, name: str) -> None:
        self.calls.append(("cancel", name))


@pytest.fixture()
def env(monkeypatch: pytest.MonkeyPatch) -> tuple[TestClient, FakeRunner]:
    runner = FakeRunner()
    monkeypatch.setattr(main, "_store", MemoryStore())
    monkeypatch.setattr(main, "_runner", runner)
    return TestClient(main.app), runner


def _start(client: TestClient) -> str:
    r = client.post("/py/runs", json={"url": "https://example.com/d.csv", "target": "y", "max_experiments": 2})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _ev(seq: int, typ: str = "experiment_scored") -> str:
    return json.dumps({"run_id": "r", "seq": seq, "type": typ})


def test_health(env: tuple[TestClient, FakeRunner]) -> None:
    client, _ = env
    assert client.get("/py/health").json()["ok"] is True


def test_start_validates_input(env: tuple[TestClient, FakeRunner]) -> None:
    client, runner = env
    assert client.post("/py/runs", json={"url": "http://x.com/a.csv", "target": "y"}).status_code == 422
    assert client.post("/py/runs", json={"url": "https://x.com/a.csv", "target": "y",
                                         "max_experiments": 4}).status_code == 422
    assert runner.calls == []


def test_token_is_stored_hashed_and_checked(env: tuple[TestClient, FakeRunner]) -> None:
    client, runner = env
    rid = _start(client)
    assert runner.ingest_url.endswith(f"/py/runs/{rid}/ingest")
    stored = main._store.runs[rid]  # type: ignore[union-attr]
    assert runner.token not in json.dumps(stored) and stored["token_sha256"] == main.sha256(runner.token)
    body = {"kind": "events", "lines": [_ev(1)]}
    assert client.post(f"/py/runs/{rid}/ingest", json=body).status_code == 401
    assert client.post(f"/py/runs/{rid}/ingest", json=body, headers={"X-Ingest-Token": "nope"}).status_code == 401
    assert client.post("/py/runs/missing/ingest", json=body,
                       headers={"X-Ingest-Token": runner.token}).status_code == 401
    assert client.post(f"/py/runs/{rid}/ingest", json=body,
                       headers={"X-Ingest-Token": runner.token}).status_code == 200
    assert "token_sha256" not in client.get(f"/py/runs/{rid}").json()["run"]


def test_events_are_ordered_deduplicated_and_paged(env: tuple[TestClient, FakeRunner]) -> None:
    client, runner = env
    rid = _start(client)
    h = {"X-Ingest-Token": runner.token}
    r = client.post(f"/py/runs/{rid}/ingest", json={"kind": "events", "lines": [_ev(2), _ev(1), "not json"]}, headers=h)
    assert r.json() == {"ok": True, "accepted": 2, "skipped": 1}
    # a forwarder retry re-sends a batch: duplicates are dropped
    r = client.post(f"/py/runs/{rid}/ingest", json={"kind": "events", "lines": [_ev(2), _ev(3)]}, headers=h)
    assert r.json()["accepted"] == 1
    got = client.get(f"/py/runs/{rid}").json()
    assert [e["seq"] for e in got["events"]] == [1, 2, 3] and got["next_after"] == 3
    got = client.get(f"/py/runs/{rid}", params={"after": 2}).json()
    assert [e["seq"] for e in got["events"]] == [3]
    assert client.get(f"/py/runs/{rid}", params={"after": 3}).json()["next_after"] == 3


def test_exit_finishes_the_run_and_stops_the_sandbox(env: tuple[TestClient, FakeRunner]) -> None:
    client, runner = env
    rid = _start(client)
    tail = "boom\nAuthorization: Bearer gsk_abc123"
    r = client.post(f"/py/runs/{rid}/ingest", json={"kind": "exit", "exit_code": 0, "stderr_tail": tail},
                    headers={"X-Ingest-Token": runner.token})
    assert r.status_code == 200
    run = client.get(f"/py/runs/{rid}").json()["run"]
    assert run["status"] == "finished" and run["exit_code"] == 0
    assert "gsk_" not in run["error_tail"] and "[redacted]" in run["error_tail"]
    assert ("cancel", "autotinker-spike-x") in runner.calls


def test_stop_graceful_then_hard(env: tuple[TestClient, FakeRunner]) -> None:
    client, runner = env
    rid = _start(client)
    assert client.post(f"/py/runs/{rid}/stop").json()["status"] == "running"
    assert ("request_stop", "autotinker-spike-x") in runner.calls
    assert client.post(f"/py/runs/{rid}/stop", json={"hard": True}).json()["status"] == "cancelled"
    assert ("cancel", "autotinker-spike-x") in runner.calls
    assert client.post(f"/py/runs/{rid}/stop").json()["note"] == "already finished"


def test_run_policy_brokers_secrets_and_engine_env_holds_none() -> None:
    env = {"GROQ_API_KEY": "gsk_real", "GEMINI_API_KEY": "AIza_real", "VERCEL_AUTOMATION_BYPASS_SECRET": "byp"}
    policy = run_policy("https://raw.githubusercontent.com/a/b/c.csv", "spike.vercel.app", env)
    dumped = repr(policy)
    for host in ("api.groq.com", "generativelanguage.googleapis.com", "raw.githubusercontent.com",
                 "spike.vercel.app"):
        assert host in dumped
    assert "pypi.org" not in dumped and "github.com'" not in dumped
    eenv = engine_env(env)
    assert eenv["GROQ_API_KEY"] == PLACEHOLDER_KEY and eenv["GEMINI_API_KEY"] == PLACEHOLDER_KEY
    assert not any(v in json.dumps(eenv) for v in ("gsk_real", "AIza_real", "byp"))
    assert dataset_hosts("https://github.com/a/b/blob/main/x.csv") == ["github.com", "raw.githubusercontent.com"]


def test_forwarder_script_compiles() -> None:
    compile(FORWARD_PY, "forward.py", "exec")
