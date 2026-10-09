"""The HTTP API against a real (temporary) Postgres with a fake runner: identity, ownership, run lifecycle, ingest,
SSE resume, steering/stop routing, the watchdog and rate limits."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from conftest import FakeRunner, run_async
from fastapi.testclient import TestClient

from autotinker_api import db, identity, repo
from autotinker_api.preview import service as preview_service

PUBLIC_IP = "93.184.216.34"


@pytest.fixture(autouse=True)
def public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    """POST /api/runs SSRF-checks the link; resolve every test host to a public address without real DNS."""
    import autotinker_api.urlguard as guard

    monkeypatch.setattr(
        guard, "system_resolve", lambda host: ["10.0.0.9"] if host == "internal.example" else [PUBLIC_IP]
    )


def start(client: TestClient, **over: Any) -> dict[str, Any]:
    body = {"url": "https://data.example/BreastCancer.csv", "target": "Class", "maxExperiments": 3, **over}
    r = client.post("/api/runs", json=body)
    assert r.status_code == 201, r.text
    return dict(r.json())


def ev(seq: int, typ: str = "agent_step_started", **kw: Any) -> dict[str, Any]:
    return {"run_id": "x", "seq": seq, "type": typ, "ts": "2026-10-08T10:00:00Z", **kw}


async def _db(fn: Any, *args: Any, **kw: Any) -> Any:
    async with db.connection() as conn:
        return await fn(conn, *args, **kw)


def append(run_id: str, events: list[dict[str, Any]]) -> int:
    return int(run_async(_db(repo.append_events, run_id, events)))


def token_for(fake: FakeRunner, run_id: str) -> str:
    return next(r.ingest_token for r in fake.started if r.run["id"] == run_id)


# ----------------------------------------------------------------------------------------------------- identity


def test_cookie_is_compatible_with_the_nextjs_backend() -> None:
    secret = "test-secret-0123456789abcdefghijklmnopqrstuvwxyz"
    node_signed = "o-AAAAAAAAAAAAAAAAAAAAAAAA.bpKz-8JZQAMMpno6fef2sw8f05R7ey51JNiPkgBD-Ww"  # from node:crypto
    assert identity.sign_owner("o-AAAAAAAAAAAAAAAAAAAAAAAA", secret) == node_signed
    assert identity.verify_owner(node_signed, secret) == "o-AAAAAAAAAAAAAAAAAAAAAAAA"
    assert identity.verify_owner(node_signed[:-1] + "x", secret) is None
    assert identity.verify_owner("o-short.sig", secret) is None
    assert identity.verify_owner(node_signed, "another-secret-0123456789abcdefghijklmnop") is None
    fresh = identity.new_owner_id()
    assert identity.verify_owner(identity.sign_owner(fresh, secret), secret) == fresh


def test_owner_cookie_minted_once_httponly(client: TestClient) -> None:
    r = client.get("/api/sessions")
    assert r.status_code == 200 and r.json() == {"sessions": []}
    cookie = r.headers["set-cookie"]
    assert cookie.startswith("at_owner=o-") and "HttpOnly" in cookie and "SameSite=lax" in cookie
    assert "Secure" not in cookie  # local http dev
    assert "set-cookie" not in client.get("/api/sessions").headers  # reused
    assert "set-cookie" not in client.get("/api/health").headers


def test_forged_cookie_gets_a_new_identity(client: TestClient) -> None:
    client.cookies.set("at_owner", "o-AAAAAAAAAAAAAAAAAAAAAAAA.forged")
    r = client.get("/api/sessions")
    assert "at_owner=o-" in r.headers["set-cookie"]


# --------------------------------------------------------------------------------------------------- lifecycle


def test_run_lifecycle(client: TestClient, fake_runner: FakeRunner) -> None:
    body = start(client, goal="predict malignant tumours", sentence="https://data.example/BreastCancer.csv tumours")
    run_id, sid = body["id"], body["sessionId"]
    meta = body["meta"]
    assert meta["status"] == "queued" and meta["runner"] == "local" and meta["sessionId"] == sid
    assert meta["sourceUrl"] == "https://data.example/BreastCancer.csv" and meta["fileName"] == "BreastCancer.csv"
    assert meta["description"] == "predict malignant tumours" and meta["maxExperiments"] == 3
    assert "ingest_token_sha256" not in json.dumps(meta)
    assert fake_runner.calls == [("start", run_id)]
    req = fake_runner.started[0]
    assert req.ingest_url.endswith(f"/api/runs/{run_id}/ingest")
    assert req.run["ingest_token_sha256"] == __import__("hashlib").sha256(req.ingest_token.encode()).hexdigest()

    append(run_id, [ev(0, "run_started", profile={"metric": "roc_auc", "problem_type": "binary", "n_rows": 699})])
    append(run_id, [ev(1), ev(2, "decision", best_cv_mean=0.97)])
    r = client.get(f"/api/runs/{run_id}")
    assert r.json()["meta"]["status"] == "running"
    assert [e["seq"] for e in r.json()["events"]] == [0, 1, 2]
    assert [e["seq"] for e in client.get(f"/api/runs/{run_id}?after=1").json()["events"]] == [2]
    assert append(run_id, [ev(2, "decision", best_cv_mean=0.5)]) == 0  # duplicate seq ignored

    sessions = client.get("/api/sessions").json()["sessions"]
    assert sessions[0]["id"] == sid and sessions[0]["best"] == 0.97 and sessions[0]["status"] == "running"
    assert sessions[0]["title"] == "Predicting malignant tumours"

    s = client.get(f"/api/sessions/{sid}").json()
    assert s["session"]["id"] == sid and s["messages"][0]["text"].endswith("tumours")
    assert s["runs"][0]["row"]["summary"]["task"]["metric"] == "roc_auc"
    assert len(s["runs"][0]["events"]) == 3 and s["runs"][0]["meta"]["id"] == run_id

    tok = token_for(fake_runner, run_id)
    hdr = {"X-Ingest-Token": tok}
    assert client.post(f"/api/runs/{run_id}/ingest", json={"kind": "record", "record": {"x": 1}}, headers=hdr).json()
    assert (
        client.post(f"/api/runs/{run_id}/ingest", json={"kind": "exit", "exit_code": 0}, headers=hdr).status_code == 200
    )
    final = client.get(f"/api/runs/{run_id}").json()
    assert final["meta"]["status"] == "finished" and final["record"] == {"x": 1} and "finishedAt" in final["meta"]


def test_start_validation(client: TestClient, fake_runner: FakeRunner) -> None:
    bad = [
        ({"url": "http://data.example/a.csv", "target": "y"}, "url"),
        ({"url": "https://u:p@data.example/a.csv", "target": "y"}, "url"),
        ({"url": "https://internal.example/a.csv", "target": "y"}, "url"),  # SSRF: resolves to a private address
        ({"url": "https://data.example/a.csv", "target": ""}, "target"),
        ({"url": "https://data.example/a.csv", "target": "y", "maxExperiments": 11}, "maxExperiments"),
        ({"url": "https://data.example/a.csv", "target": "y", "metric": "nope"}, "metric"),
    ]
    for body, field in bad:
        r = client.post("/api/runs", json=body)
        assert r.status_code == 400 and r.json()["field"] == field, (body, r.text)
    assert fake_runner.calls == []
    r = client.post("/api/runs", json={"url": "https://github.com/o/r/blob/main/d.csv", "target": "y"})
    assert r.json()["meta"]["sourceUrl"] == "https://raw.githubusercontent.com/o/r/main/d.csv"


def test_upload_run(client: TestClient, fake_runner: FakeRunner) -> None:
    csv = "a,b,y\n" + "".join(f"{i},{i * 2},{i % 2}\n" for i in range(30))
    r = client.post(
        "/api/runs", data={"target": "y", "maxExperiments": "2"}, files={"file": ("d.csv", csv.encode(), "text/csv")}
    )
    assert r.status_code == 201, r.text
    assert r.json()["meta"]["source"] == "file" and r.json()["meta"]["fileBytes"] == len(csv)
    assert fake_runner.started[0].csv == csv.encode()
    r = client.post("/api/runs", data={"target": "nope"}, files={"file": ("d.csv", csv.encode(), "text/csv")})
    assert r.status_code == 400 and r.json()["field"] == "target"


# --------------------------------------------------------------------------------------------------- ownership


def test_other_browsers_see_nothing(client: TestClient, other: TestClient, fake_runner: FakeRunner) -> None:
    body = start(client)
    run_id, sid = body["id"], body["sessionId"]
    other.get("/api/sessions")
    for method, path, payload in [
        ("get", f"/api/runs/{run_id}", None),
        ("get", f"/api/runs/{run_id}/stream", None),
        ("post", f"/api/runs/{run_id}/cancel", None),
        ("get", f"/api/sessions/{sid}", None),
        ("patch", f"/api/sessions/{sid}", {"title": "mine now"}),
        ("post", f"/api/sessions/{sid}/messages", {"text": "hi"}),
    ]:
        r = getattr(other, method)(path, json=payload) if payload else getattr(other, method)(path)
        assert r.status_code == 404, (method, path, r.text)
    assert other.get("/api/sessions").json()["sessions"] == []
    r = other.post("/api/runs", json={"url": "https://data.example/a.csv", "target": "y", "sessionId": sid})
    assert r.status_code == 404 and r.json()["field"] == "sessionId"
    assert ("cancel", run_id) not in fake_runner.calls
    assert client.get(f"/api/runs/{run_id}").status_code == 200


def test_rename(client: TestClient) -> None:
    sid = start(client)["sessionId"]
    assert client.patch(f"/api/sessions/{sid}", json={"title": "  Tumours  v2 "}).json() == {"title": "Tumours v2"}
    assert client.patch(f"/api/sessions/{sid}", json={"title": ""}).status_code == 400
    assert client.get("/api/sessions").json()["sessions"][0]["title"] == "Tumours v2"


# ------------------------------------------------------------------------------------------------------ ingest


def test_ingest_token(client: TestClient, fake_runner: FakeRunner) -> None:
    run_id = start(client)["id"]
    lines = [json.dumps(ev(0)), "not json", json.dumps({"seq": "x"})]
    assert client.post(f"/api/runs/{run_id}/ingest", json={"kind": "events", "lines": lines}).status_code == 401
    bad = {"X-Ingest-Token": "nope"}
    assert (
        client.post(f"/api/runs/{run_id}/ingest", json={"kind": "events", "lines": lines}, headers=bad).status_code
        == 401
    )
    good = {"X-Ingest-Token": token_for(fake_runner, run_id)}
    assert client.post("/api/runs/r-unknown000/ingest", json={"kind": "heartbeat"}, headers=good).status_code == 401
    r = client.post(f"/api/runs/{run_id}/ingest", json={"kind": "events", "lines": lines}, headers=good)
    assert r.json() == {"ok": True, "accepted": 1, "skipped": 2}
    assert client.post(f"/api/runs/{run_id}/ingest", json={"kind": "heartbeat"}, headers=good).json() == {"ok": True}
    tail = "Traceback\nAuthorization: Bearer " + "gsk" + "_abcdefghijklmnop1234\nboom"
    client.post(f"/api/runs/{run_id}/ingest", json={"kind": "exit", "exit_code": 2, "stderr_tail": tail}, headers=good)
    meta = client.get(f"/api/runs/{run_id}").json()["meta"]
    assert (
        meta["status"] == "failed" and "abcdefghijklmnop1234" not in meta["errorTail"] and "boom" in meta["errorTail"]
    )


def test_late_exit_does_not_undo_a_cancel(client: TestClient, fake_runner: FakeRunner) -> None:
    run_id = start(client)["id"]
    assert client.post(f"/api/runs/{run_id}/cancel").json()["cancelled"] is True
    assert ("cancel", run_id) in fake_runner.calls
    good = {"X-Ingest-Token": token_for(fake_runner, run_id)}
    client.post(f"/api/runs/{run_id}/ingest", json={"kind": "exit", "exit_code": 0}, headers=good)
    assert client.get(f"/api/runs/{run_id}").json()["meta"]["status"] == "cancelled"
    assert client.post(f"/api/runs/{run_id}/cancel").json()["cancelled"] is False


# --------------------------------------------------------------------------------------------------------- SSE


def _sse(text: str) -> list[dict[str, str]]:
    out = []
    for block in text.split("\n\n"):
        fields: dict[str, str] = {}
        for line in block.split("\n"):
            if ":" in line and not line.startswith(":"):
                k, v = line.split(":", 1)
                fields[k] = v.strip()
        if fields:
            out.append(fields)
    return out


def test_sse_replays_resumes_and_ends(client: TestClient, fake_runner: FakeRunner) -> None:
    run_id = start(client)["id"]
    append(run_id, [ev(i) for i in range(5)])
    run_async(_db(repo.finish_run, run_id, "finished"))
    text = client.get(f"/api/runs/{run_id}/stream").text
    msgs = _sse(text)
    assert msgs[0] == {"retry": "2000"}
    assert msgs[1]["event"] == "meta" and json.loads(msgs[1]["data"])["status"] == "finished"
    assert [int(m["id"]) for m in msgs if "id" in m] == [0, 1, 2, 3, 4]
    assert msgs[-1]["event"] == "end"
    resumed = _sse(client.get(f"/api/runs/{run_id}/stream", headers={"Last-Event-ID": "2"}).text)
    assert [int(m["id"]) for m in resumed if "id" in m] == [3, 4]
    via_query = _sse(client.get(f"/api/runs/{run_id}/stream?after=3").text)
    assert [int(m["id"]) for m in via_query if "id" in m] == [4]


def test_sse_closes_after_its_time_budget(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOTINKER_SSE_MAX_S", "1")
    run_id = start(client)["id"]
    append(run_id, [ev(0)])
    msgs = _sse(client.get(f"/api/runs/{run_id}/stream").text)  # returns once the budget is spent
    assert [m.get("id") for m in msgs if "id" in m] == ["0"] and all(m.get("event") != "end" for m in msgs)


# ---------------------------------------------------------------------------------------------- steer and stop


def test_messages_route_to_the_engine(client: TestClient, fake_runner: FakeRunner) -> None:
    body = start(client)
    sid, run_id = body["sessionId"], body["id"]
    append(run_id, [ev(0)])
    r = client.post(f"/api/sessions/{sid}/messages", json={"text": "prefer simple linear models"})
    assert r.status_code == 201 and r.json()["intent"] == "steer" and r.json()["delivered"] is True
    assert ("control", {"type": "steer", "text": "prefer simple linear models"}) in fake_runner.calls

    fake_runner.deliver = False
    r = client.post(f"/api/sessions/{sid}/messages", json={"text": "try trees"})
    assert r.json()["delivered"] is False and r.json()["messages"][-1]["role"] == "system"

    fake_runner.deliver = True
    r = client.post(f"/api/sessions/{sid}/messages", json={"text": "Stop!"})
    assert r.json()["intent"] == "control" and r.json()["delivered"] is True
    assert ("control", {"type": "stop"}) in fake_runner.calls
    assert r.json()["messages"][-1]["text"].startswith("Stopping after the current experiment")

    append(run_id, [ev(1, "stopped", reason="user", summary="stopped by user")])
    assert client.post(f"/api/sessions/{sid}/messages", json={"kind": "stop"}).status_code == 409
    msgs = client.get(f"/api/sessions/{sid}").json()["messages"]
    assert [m["kind"] for m in msgs if m["role"] == "user"] == ["steer", "steer", "control"]


def test_stop_without_a_channel_cancels(client: TestClient, fake_runner: FakeRunner) -> None:
    body = start(client)
    fake_runner.deliver = False
    r = client.post(f"/api/sessions/{body['sessionId']}/messages", json={"kind": "stop"})
    assert r.json()["delivered"] is False and ("cancel", body["id"]) in fake_runner.calls
    assert client.get(f"/api/runs/{body['id']}").json()["meta"]["status"] == "cancelled"
    r = client.post(f"/api/sessions/{body['sessionId']}/messages", json={"text": "hello"})
    assert r.json()["intent"] == "chat" and r.json()["messages"][-1]["role"] == "system"
    assert client.post(f"/api/sessions/{body['sessionId']}/messages", json={"kind": "stop"}).status_code == 409


# ---------------------------------------------------------------------------------------------------- watchdog


def _age(run_id: str, **cols: datetime) -> None:
    async def go(conn: db.Conn) -> None:
        for k, v in cols.items():
            await conn.execute(f"update runs set {k} = %s where id = %s", (v, run_id))

    run_async(_db(go))


def test_watchdog_times_out_a_quiet_run(client: TestClient, fake_runner: FakeRunner) -> None:
    body = start(client)
    run_id = body["id"]
    append(run_id, [ev(0), ev(1, "decision", best_cv_mean=0.9)])
    assert client.get(f"/api/runs/{run_id}").json()["meta"]["status"] == "running"
    _age(run_id, last_seen_at=datetime.now(UTC) - timedelta(minutes=11))
    meta = client.get(f"/api/runs/{run_id}").json()["meta"]
    assert meta["status"] == "timed_out" and "stopped responding" in meta["error"]
    assert ("cancel", run_id) in fake_runner.calls
    s = client.get(f"/api/sessions/{body['sessionId']}").json()
    assert len(s["runs"][0]["events"]) == 2 and s["runs"][0]["row"]["best"] == 0.9  # experiments are kept


def test_watchdog_deadline_and_sweep(client: TestClient, fake_runner: FakeRunner) -> None:
    a = start(client)["id"]
    _age(a, deadline_at=datetime.now(UTC) - timedelta(seconds=1))
    start(client)  # starting a run sweeps the active ones
    meta = client.get(f"/api/runs/{a}").json()["meta"]
    assert meta["status"] == "timed_out" and "time limit" in meta["error"]


# ------------------------------------------------------------------------------------------------- rate limits


def test_run_rate_limit_per_owner_and_ip(
    client: TestClient, other: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AUTOTINKER_RUNS_PER_OWNER_PER_HOUR", "2")
    monkeypatch.setenv("AUTOTINKER_RUNS_PER_IP_PER_HOUR", "3")
    start(client)
    start(client)
    r = client.post("/api/runs", json={"url": "https://data.example/a.csv", "target": "y"})
    assert r.status_code == 429 and int(r.headers["Retry-After"]) > 0 and "maximum number" in r.json()["error"]
    other.get("/api/sessions")
    # The same IP (the test client) has used 3 hits (2 ok + 1 denied): the other browser is now limited by IP.
    r = other.post("/api/runs", json={"url": "https://data.example/a.csv", "target": "y"})
    assert r.status_code == 429
    r = other.post(
        "/api/runs", json={"url": "https://data.example/a.csv", "target": "y"}, headers={"x-real-ip": "1.2.3.4"}
    )
    assert r.status_code == 201
    # A typo doesn't burn a run.
    assert client.post("/api/runs", json={"url": "nope", "target": "y"}).status_code == 400


def test_preview_rate_limit(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOTINKER_PREVIEWS_PER_MIN", "2")

    async def fake_preview(url: str) -> dict[str, Any]:
        return {"stats": [], "sample": [], "url": url}

    monkeypatch.setattr("autotinker_api.routes.preview.cached_preview", fake_preview)
    for _ in range(2):
        assert client.post("/api/preview", json={"url": "https://data.example/a.csv"}).status_code == 200
    r = client.post("/api/preview", json={"url": "https://data.example/a.csv"})
    assert r.status_code == 429 and r.json()["code"] == "rate_limited"


def test_preview_route_errors(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    assert client.post("/api/preview", json={"url": ""}).json()["code"] == "invalid_url"
    r = client.post("/api/preview", json={"url": "https://internal.example/x.csv"})
    assert r.status_code == 422 and r.json()["code"] == "blocked_host"
    preview_service._cache.clear()


def test_live_runs_switch(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOTINKER_LIVE_RUNS", "0")
    assert client.post("/api/runs", json={"url": "https://data.example/a.csv", "target": "y"}).status_code == 503


def test_without_a_database(app: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL")
    with TestClient(app) as c:
        r = c.get("/api/sessions")
        assert r.status_code == 503 and r.json()["sessions"] == []
        assert c.get("/api/sessions/s-abcdefabcdef").status_code == 503
        assert c.post("/api/runs", json={"url": "https://data.example/a.csv", "target": "y"}).status_code == 503


def test_blocked_targets_are_rejected(client: TestClient, fake_runner: FakeRunner) -> None:
    """IDs, free text, constant and mostly-empty columns can't be the column to predict (mirrors the setup form)."""
    rows = [
        f"{i},Passenger number {i} with a long unique name {i * 7919},1,{'' if i % 3 else f'v{i}'},{i % 2}"
        for i in range(40)
    ]
    csv = "PassengerId,Name,const,sparse,y\n" + "\n".join(rows) + "\n"
    for target, why in (
        ("PassengerId", "ID column"),
        ("Name", "Free text"),
        ("const", "Constant"),
        ("sparse", "Mostly missing"),
    ):
        r = client.post("/api/runs", data={"target": target}, files={"file": ("d.csv", csv.encode(), "text/csv")})
        assert r.status_code == 400, (target, r.text)
        assert r.json()["field"] == "target" and why in r.json()["error"], r.json()
    r = client.post("/api/runs", data={"target": "y"}, files={"file": ("d.csv", csv.encode(), "text/csv")})
    assert r.status_code == 201, r.text


def test_blocked_target_from_cached_link_preview(client: TestClient, fake_runner: FakeRunner) -> None:
    url = "https://example.com/t.csv"
    stats = [
        {"name": "PassengerId", "kind": "id", "count": 891, "missing": 0, "unique": 891},
        {"name": "Survived", "kind": "boolean", "count": 891, "missing": 0, "unique": 2, "minCount": 342},
    ]
    preview_service._cache[url] = (time.monotonic(), {"stats": stats})
    try:
        r = client.post("/api/runs", json={"url": url, "target": "PassengerId"})
        assert r.status_code == 400 and "ID column" in r.json()["error"]
        assert client.post("/api/runs", json={"url": url, "target": "Survived"}).status_code == 201
    finally:
        preview_service._cache.pop(url, None)
