"""GET /api/dashboard: owner isolation, the empty account, oriented -> natural scores, the token-cost math, the window
and the 401 a signed-out caller gets under Clerk."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from conftest import run_async
from fastapi.testclient import TestClient
from test_auth import bearer, clerk, token  # noqa: F401  (clerk is a fixture)

from autotinker_api import dashboard, db, identity

ME, THEM = "o-AAAAAAAAAAAAAAAAAAAAAAAA", "o-BBBBBBBBBBBBBBBBBBBBBBBB"


def as_owner(client: TestClient, owner: str) -> TestClient:
    client.cookies.set(identity.OWNER_COOKIE, identity.sign_owner(owner))
    return client


async def _seed(
    owner: str,
    run_id: str,
    *,
    session_id: str | None = None,
    title: str = "A session",
    status: str = "finished",
    metric: str | None = "roc_auc",
    created: datetime | None = None,
    finished_after_s: float | None = 60.0,
    file_name: str | None = None,
    source_url: str | None = "https://data.example/path/BreastCancer.csv",
    events: list[dict[str, Any]] | None = None,
    model_asset: str | None = None,
    error_code: str | None = None,
) -> None:
    created = created or datetime.now(UTC) - timedelta(minutes=5)
    session_id = session_id or "s-" + run_id[2:]
    finished = created + timedelta(seconds=finished_after_s) if finished_after_s is not None else None
    async with db.connection() as conn:
        await conn.execute("insert into owners (id) values (%s) on conflict do nothing", (owner,))
        await conn.execute(
            "insert into sessions (id, owner_id, title) values (%s, %s, %s) on conflict do nothing",
            (session_id, owner, title),
        )
        await conn.execute(
            """insert into runs (id, session_id, status, source_url, file_name, target, metric, max_experiments,
                                 created_at, finished_at, error_code)
               values (%s, %s, %s, %s, %s, 'y', %s, 5, %s, %s, %s)""",
            (run_id, session_id, status, source_url, file_name, metric, created, finished, error_code),
        )
        for seq, ev in enumerate(events or []):
            await conn.execute(
                "insert into run_events (run_id, seq, type, payload, ts) values (%s, %s, %s, %s::jsonb, %s)",
                (run_id, seq, ev["type"], json.dumps({"run_id": run_id, "seq": seq, **ev}), created),
            )
        if model_asset:
            await conn.execute(
                "insert into run_assets (run_id, name, kind, storage) values (%s, 'model.joblib', 'model', %s)",
                (run_id, model_asset),
            )


def seed(owner: str, run_id: str, **kw: Any) -> None:
    run_async(_seed(owner, run_id, **kw))


def llm(model: str, tin: int, tout: int) -> dict[str, Any]:
    return {"type": "llm_call", "usage": {"model": model, "input_tokens": tin, "output_tokens": tout}}


def decision(d: str) -> dict[str, Any]:
    return {"type": "decision", "decision": d, "exp_id": "e", "best_exp_id": "e", "best_cv_mean": 0.0}


def started(problem_type: str, metric: str) -> dict[str, Any]:
    return {"type": "run_started", "profile": {"problem_type": problem_type, "metric": metric, "n_rows": 100}}


def finished(dev_cv: float, test: float, gap: float, wall: float = 42.0) -> dict[str, Any]:
    return {
        "type": "run_finished",
        "dev_cv_mean": dev_cv,
        "select_score": dev_cv,
        "test_score": test,
        "optimism_gap": gap,
        "n_experiments": 2,
        "wall_time_s": wall,
    }


def get(client: TestClient, **params: Any) -> dict[str, Any]:
    r = client.get("/api/dashboard", params=params)
    assert r.status_code == 200, r.text
    return dict(r.json())


# ---------------------------------------------------------------------------------------------------- empty


def test_empty_account(client: TestClient) -> None:
    out = get(as_owner(client, ME))
    s = out["summary"]
    assert s["runs"] == s["sessions"] == s["experiments"] == s["tokensIn"] == s["models"] == 0
    assert s["successRate"] is None and s["keepRate"] is None and s["avgRunSeconds"] is None
    assert s["medianOptimismGap"] is None and s["firstRunAt"] is None and s["lastRunAt"] is None
    assert s["equivCostUsd"] == 0 and s["computeSeconds"] == 0
    assert out["recentRuns"] == out["quality"] == out["metrics"] == out["providers"] == []
    assert len(out["series"]) == 30
    assert all(d["runs"] == 0 and d["tokens"] == 0 and d["equivCostUsd"] == 0 for d in out["series"])
    dates = [d["date"] for d in out["series"]]
    assert dates == sorted(dates) and dates[-1] == datetime.now(UTC).date().isoformat()
    assert out["pricing"] == {"model": "gpt-oss-120b", "provider": "Groq", "input": 0.15, "output": 0.6}


# ------------------------------------------------------------------------------------------------ isolation


def test_only_the_callers_runs(client: TestClient) -> None:
    seed(ME, "r-mine000001", events=[llm("groq/openai/gpt-oss-120b", 1000, 100)])
    seed(THEM, "r-theirs0001", events=[llm("gemini/x", 5000, 500), decision("keep")], model_asset="local")
    out = get(as_owner(client, ME))
    assert [r["id"] for r in out["recentRuns"]] == ["r-mine000001"]
    assert out["summary"]["runs"] == 1 and out["summary"]["sessions"] == 1 and out["summary"]["models"] == 0
    assert [p["model"] for p in out["providers"]] == ["groq/openai/gpt-oss-120b"]
    assert out["summary"]["tokensIn"] == 1000


# ------------------------------------------------------------------------------------ scores and aggregates


def test_log_loss_scores_come_back_natural_and_the_gap_keeps_its_sign(client: TestClient) -> None:
    # oriented: cv -0.20, test -0.30 (worse), gap = select - test = +0.10
    seed(
        ME,
        "r-logloss001",
        metric=None,  # the engine picked it: taken from run_started's profile
        events=[started("multiclass", "log_loss"), decision("keep"), finished(-0.20, -0.30, 0.10)],
        model_asset="blob",
    )
    out = get(as_owner(client, ME))
    run = out["recentRuns"][0]
    assert run["metric"] == "log_loss" and run["problemType"] == "multiclass"
    assert run["bestCv"] == pytest.approx(0.20) and run["testScore"] == pytest.approx(0.30)
    assert run["optimismGap"] == pytest.approx(0.10)
    assert run["hasModel"] is True and run["durationS"] == pytest.approx(42.0)
    q = out["quality"][0]
    assert (q["cv"], q["test"], q["gap"]) == (pytest.approx(0.20), pytest.approx(0.30), pytest.approx(0.10))
    assert out["metrics"] == [{"metric": "log_loss", "runs": 1}]


def test_roc_auc_is_already_natural(client: TestClient) -> None:
    seed(ME, "r-rocauc0001", events=[started("binary", "roc_auc"), finished(0.88, 0.80, 0.08)])
    run = get(as_owner(client, ME))["recentRuns"][0]
    assert run["bestCv"] == pytest.approx(0.88) and run["testScore"] == pytest.approx(0.80)
    assert run["optimismGap"] == pytest.approx(0.08)


def test_counts_cost_and_rates(client: TestClient) -> None:
    now = datetime.now(UTC)
    seed(
        ME,
        "r-finished01",
        session_id="s-shared000001",
        created=now - timedelta(hours=3),
        events=[
            llm("groq/openai/gpt-oss-120b", 1_000_000, 0),
            llm("groq/openai/gpt-oss-120b", 0, 1_000_000),
            llm("gemini/gemini-flash", 2_000_000, 1_000_000),
            decision("keep"),
            decision("discard"),
            decision("crash"),
            finished(0.9, 0.85, 0.05, wall=100.0),
        ],
        model_asset="local",
    )
    seed(ME, "r-finished02", session_id="s-shared000001", created=now - timedelta(hours=2), finished_after_s=50)
    seed(ME, "r-skipmodel1", created=now - timedelta(hours=1), events=[finished(0.7, 0.6, 0.15, wall=20.0)],
         model_asset="skipped")  # fmt: skip
    seed(ME, "r-failed0001", status="failed", error_code="target_missing", file_name="wine.csv")
    seed(ME, "r-timedout01", status="timed_out", source_url="https://host.example/")
    seed(ME, "r-cancelled1", status="cancelled")
    seed(ME, "r-running001", status="running", finished_after_s=None)

    out = get(as_owner(client, ME))
    s = out["summary"]
    assert s["sessions"] == 6 and s["runs"] == 7
    assert (s["finished"], s["failed"], s["running"]) == (3, 1, 1)
    assert s["successRate"] == pytest.approx(3 / 6)
    assert (s["experiments"], s["kept"]) == (3, 1) and s["keepRate"] == pytest.approx(1 / 3)
    assert s["models"] == 1
    assert (s["tokensIn"], s["tokensOut"]) == (3_000_000, 2_000_000)
    # 3M in x $0.15 + 2M out x $0.60
    assert s["equivCostUsd"] == pytest.approx(0.45 + 1.20)
    assert s["computeSeconds"] == pytest.approx(100 + 50 + 20) and s["avgRunSeconds"] == pytest.approx(170 / 3)
    assert s["medianOptimismGap"] == pytest.approx(0.10)

    providers = {p["model"]: p for p in out["providers"]}
    assert [p["model"] for p in out["providers"]][0] == "groq/openai/gpt-oss-120b"
    assert providers["groq/openai/gpt-oss-120b"]["calls"] == 2
    assert providers["groq/openai/gpt-oss-120b"]["equivCostUsd"] == pytest.approx(0.15 + 0.60)
    assert providers["gemini/gemini-flash"]["tokens"] == 3_000_000

    runs = {r["id"]: r for r in out["recentRuns"]}
    assert runs["r-failed0001"]["dataset"] == "wine.csv" and runs["r-failed0001"]["errorCode"] == "target_missing"
    assert runs["r-finished01"]["dataset"] == "BreastCancer.csv"
    assert runs["r-timedout01"]["dataset"] == "host.example"
    assert runs["r-running001"]["durationS"] is None and runs["r-failed0001"]["durationS"] is None
    assert runs["r-skipmodel1"]["hasModel"] is False
    assert [q["runId"] for q in out["quality"]] == ["r-skipmodel1", "r-finished01"]

    today = out["series"][-1]
    assert today["runs"] + out["series"][-2]["runs"] == 7
    assert sum(d["tokens"] for d in out["series"]) == 5_000_000
    assert sum(d["equivCostUsd"] for d in out["series"]) == pytest.approx(1.65)


def test_recent_runs_newest_first_capped(client: TestClient) -> None:
    now = datetime.now(UTC)
    for i in range(15):
        seed(ME, f"r-many{i:06d}", created=now - timedelta(minutes=60 - i))
    recent = get(as_owner(client, ME))["recentRuns"]
    assert len(recent) == 12 and recent[0]["id"] == "r-many000014"
    assert [r["createdAt"] for r in recent] == sorted((r["createdAt"] for r in recent), reverse=True)


# ---------------------------------------------------------------------------------------------------- window


def test_window_and_days_bounds(client: TestClient) -> None:
    now = datetime.now(UTC)
    seed(ME, "r-recent0001", created=now - timedelta(days=2))
    seed(ME, "r-old0000001", created=now - timedelta(days=20))
    seed(ME, "r-ancient001", created=now - timedelta(days=200))
    as_owner(client, ME)
    week = get(client, days=7)
    assert len(week["series"]) == 7 and week["summary"]["runs"] == 1
    # first/last run are all-time, so a quiet window can still say when the account was last used
    assert week["summary"]["firstRunAt"] < week["summary"]["lastRunAt"]
    assert week["summary"]["firstRunAt"].startswith((now - timedelta(days=200)).date().isoformat())
    assert get(client)["summary"]["runs"] == 2  # default 30
    assert len(get(client, days=3)["series"]) == 7  # clamped up
    assert len(get(client, days=365)["series"]) == 90  # clamped down
    assert get(client, days=90)["summary"]["runs"] == 2
    r = client.get("/api/dashboard", params={"days": "lots"})
    assert r.status_code == 400 and "error" in r.json()


def test_window_start_is_utc_midnight() -> None:
    at = datetime(2026, 10, 9, 23, 30, tzinfo=UTC)
    assert dashboard.window_start(7, at) == datetime(2026, 10, 3, tzinfo=UTC)


def test_dataset_name() -> None:
    assert dashboard.dataset_name("x.csv", "https://a.example/b.csv") == "x.csv"
    assert dashboard.dataset_name(None, "https://a.example/data/b.csv?raw=1") == "b.csv"
    assert dashboard.dataset_name("", "https://a.example/") == "a.example"
    assert dashboard.dataset_name(None, None) == ""


# ------------------------------------------------------------------------------------------------------ auth


@pytest.mark.usefixtures("clerk")
def test_signed_out_gets_401_and_signed_in_sees_own(client: TestClient) -> None:
    r = client.get("/api/dashboard")
    assert r.status_code == 401 and r.json()["code"] == "auth_required"
    seed("user_2abcDEFghiJKLmnoPQR", "r-clerkrun01")
    seed(THEM, "r-theirs0002")
    r = client.get("/api/dashboard", headers=bearer(token()))
    assert r.status_code == 200, r.text
    assert [x["id"] for x in r.json()["recentRuns"]] == ["r-clerkrun01"]
