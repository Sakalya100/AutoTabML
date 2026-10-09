"""The caller's dashboard: what they ran over the last N days, what it produced, and what the tokens would have cost.

Three statements in one pipelined round trip (one row per run with its event aggregates, LLM calls grouped by model,
and the session count plus the all-time first and last run), scoped to the owner's runs created in the window;
everything else is folded in Python, which is cheap for hundreds of runs.

Scores in events are oriented (higher is better; log_loss, rmse and mae are stored negated). Everything returned here
is in the metric's natural direction, except the optimism gap, which the engine defines as select - test in oriented
units and so already reads "positive = the locked test came out worse than the estimate" for every metric.
"""

from __future__ import annotations

import statistics
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

from autotinker_api.db import Conn
from autotinker_api.repo import ACTIVE, iso

DEFAULT_DAYS, MIN_DAYS, MAX_DAYS = 30, 7, 90
RECENT_RUNS = 12
QUALITY_POINTS = 60

# What these tokens would cost on Groq gpt-oss-120b, USD per million tokens (web/src/lib/format.ts EQUIV_PRICE).
PRICE_IN, PRICE_OUT = 0.15, 0.6
PRICING: dict[str, str | float] = {"model": "gpt-oss-120b", "provider": "Groq", "input": PRICE_IN, "output": PRICE_OUT}

# Metrics stored negated (minimised); mirrors Metric.greater_is_better and web/src/lib/metrics.ts.
LOWER_IS_BETTER = frozenset({"log_loss", "rmse", "mae"})


def to_natural(metric: str | None, oriented: float | None) -> float | None:
    if oriented is None:
        return None
    v = -oriented if metric in LOWER_IS_BETTER else oriented
    return 0.0 if v == 0 else float(v)


def equiv_cost(tokens_in: int, tokens_out: int) -> float:
    return (tokens_in * PRICE_IN + tokens_out * PRICE_OUT) / 1e6


def clamp_days(days: int) -> int:
    return max(MIN_DAYS, min(MAX_DAYS, days))


def dataset_name(file_name: str | None, source_url: str | None) -> str:
    """The uploaded file's name, else the link's last path segment, else its host."""
    if file_name:
        return file_name
    if not source_url:
        return ""
    u = urlparse(source_url)
    last = u.path.rstrip("/").rsplit("/", 1)[-1]
    return last or u.hostname or source_url


_RUNS_SQL = """
with owned as (
  select r.id, r.session_id, s.title as session_title, r.status, r.created_at, r.finished_at, r.source_url,
         r.file_name, r.target, r.metric, r.best, r.error_code
    from runs r join sessions s on s.id = r.session_id
   where s.owner_id = %(owner)s and r.created_at >= %(since)s
),
ev as (
  select e.run_id,
         count(*) filter (where e.type = 'decision') as decisions,
         count(*) filter (where e.type = 'decision' and e.payload->>'decision' = 'keep') as kept,
         count(*) filter (where e.type = 'experiment_scored') as scored,
         coalesce(sum((e.payload->'usage'->>'input_tokens')::bigint) filter (where e.type = 'llm_call'), 0)::bigint
           as tokens_in,
         coalesce(sum((e.payload->'usage'->>'output_tokens')::bigint) filter (where e.type = 'llm_call'), 0)::bigint
           as tokens_out,
         max(e.payload->'profile'->>'problem_type') filter (where e.type = 'run_started') as problem_type,
         max(e.payload->'profile'->>'metric') filter (where e.type = 'run_started') as profile_metric,
         max((e.payload->>'dev_cv_mean')::float8) filter (where e.type = 'run_finished') as dev_cv_mean,
         max((e.payload->>'test_score')::float8) filter (where e.type = 'run_finished') as test_score,
         max((e.payload->>'optimism_gap')::float8) filter (where e.type = 'run_finished') as optimism_gap,
         max((e.payload->>'wall_time_s')::float8) filter (where e.type = 'run_finished') as wall_time_s
    from run_events e join owned o on o.id = e.run_id
   where e.type in ('decision', 'experiment_scored', 'llm_call', 'run_started', 'run_finished')
   group by e.run_id
)
select o.*,
       coalesce(ev.decisions, 0)::int as decisions, coalesce(ev.kept, 0)::int as kept,
       coalesce(ev.scored, 0)::int as scored,
       coalesce(ev.tokens_in, 0)::bigint as tokens_in, coalesce(ev.tokens_out, 0)::bigint as tokens_out,
       ev.problem_type, ev.profile_metric, ev.dev_cv_mean, ev.test_score, ev.optimism_gap, ev.wall_time_s,
       exists(select 1 from run_assets a
               where a.run_id = o.id and a.name = 'model.joblib' and a.storage <> 'skipped') as has_model
  from owned o left join ev on ev.run_id = o.id
 order by o.created_at desc
"""

_PROVIDERS_SQL = """
select coalesce(e.payload->'usage'->>'model', 'unknown') as model,
       count(*)::int as calls,
       coalesce(sum((e.payload->'usage'->>'input_tokens')::bigint), 0)::bigint as tokens_in,
       coalesce(sum((e.payload->'usage'->>'output_tokens')::bigint), 0)::bigint as tokens_out
  from run_events e
  join runs r on r.id = e.run_id
  join sessions s on s.id = r.session_id
 where s.owner_id = %(owner)s and r.created_at >= %(since)s and e.type = 'llm_call'
 group by 1
 order by calls desc, model
"""

_SPAN_SQL = """
select (select count(*) from sessions s
         where s.owner_id = %(owner)s
           and exists(select 1 from runs r where r.session_id = s.id and r.created_at >= %(since)s))::int as sessions,
       min(r.created_at) as first_run_at, max(r.created_at) as last_run_at
  from runs r join sessions s on s.id = r.session_id
 where s.owner_id = %(owner)s
"""


def window_start(days: int, now: datetime | None = None) -> datetime:
    """UTC midnight of the oldest day in the window (today counts as one of the `days`)."""
    today = (now or datetime.now(UTC)).astimezone(UTC).date()
    first = today - timedelta(days=days - 1)
    return datetime(first.year, first.month, first.day, tzinfo=UTC)


def _duration(run: dict[str, Any]) -> float | None:
    if run["wall_time_s"] is not None:
        return float(run["wall_time_s"])
    if run["status"] == "finished" and run["finished_at"] is not None:
        elapsed: timedelta = run["finished_at"] - run["created_at"]
        return max(0.0, elapsed.total_seconds())
    return None


def _ratio(num: int, den: int) -> float | None:
    return num / den if den > 0 else None


async def build(conn: Conn, owner: str, days: int, now: datetime | None = None) -> dict[str, Any]:
    since = window_start(days, now)
    params = {"owner": owner, "since": since}
    # One round trip for the three statements (the database may be far from the API host).
    async with conn.pipeline():
        cur_runs = await conn.execute(_RUNS_SQL, params)
        cur_providers = await conn.execute(_PROVIDERS_SQL, params)
        cur_span = await conn.execute(_SPAN_SQL, params)
    rows = list(await cur_runs.fetchall())
    providers = list(await cur_providers.fetchall())
    span = await cur_span.fetchone() or {}

    runs: list[dict[str, Any]] = []
    for r in rows:
        metric = r["metric"] or r["profile_metric"]
        experiments = r["decisions"] or r["scored"]
        tokens_in, tokens_out = int(r["tokens_in"]), int(r["tokens_out"])
        best = r["dev_cv_mean"] if r["dev_cv_mean"] is not None else r["best"]
        runs.append(
            {
                "id": r["id"],
                "sessionId": r["session_id"],
                "sessionTitle": r["session_title"],
                "status": r["status"],
                "createdAt": iso(r["created_at"]),
                "finishedAt": iso(r["finished_at"]),
                "durationS": _duration(r),
                "dataset": dataset_name(r["file_name"], r["source_url"]),
                "target": r["target"],
                "metric": metric,
                "problemType": r["problem_type"],
                "experiments": experiments,
                "kept": r["kept"],
                "bestCv": to_natural(metric, best),
                "testScore": to_natural(metric, r["test_score"]),
                "optimismGap": None if r["optimism_gap"] is None else float(r["optimism_gap"]),
                "equivCostUsd": equiv_cost(tokens_in, tokens_out),
                "tokens": tokens_in + tokens_out,
                "errorCode": r["error_code"],
                "hasModel": bool(r["has_model"]),
                # internal, dropped before the response
                "_day": r["created_at"].astimezone(UTC).date(),
                "_in": tokens_in,
                "_out": tokens_out,
            }
        )

    by_status: dict[str, int] = {}
    for run in runs:
        by_status[run["status"]] = by_status.get(run["status"], 0) + 1
    finished = by_status.get("finished", 0)
    failed = by_status.get("failed", 0)
    ended = finished + failed + by_status.get("timed_out", 0) + by_status.get("cancelled", 0)
    experiments = sum(r["experiments"] for r in runs)
    kept = sum(r["kept"] for r in runs)
    tokens_in = sum(r["_in"] for r in runs)
    tokens_out = sum(r["_out"] for r in runs)
    durations = [r["durationS"] for r in runs if r["durationS"] is not None]
    gaps = [r["optimismGap"] for r in runs if r["optimismGap"] is not None]

    summary = {
        "sessions": int(span.get("sessions") or 0),
        "runs": len(runs),
        "finished": finished,
        "failed": failed,
        "running": sum(by_status.get(s, 0) for s in ACTIVE),
        "successRate": _ratio(finished, ended),
        "experiments": experiments,
        "kept": kept,
        "keepRate": _ratio(kept, experiments),
        "models": sum(1 for r in runs if r["hasModel"]),
        "tokensIn": tokens_in,
        "tokensOut": tokens_out,
        "equivCostUsd": equiv_cost(tokens_in, tokens_out),
        "computeSeconds": float(sum(durations)),
        "avgRunSeconds": statistics.fmean(durations) if durations else None,
        "medianOptimismGap": statistics.median(gaps) if gaps else None,
        "firstRunAt": iso(span.get("first_run_at")),
        "lastRunAt": iso(span.get("last_run_at")),
    }

    first_day = since.date()
    days_out: dict[date, dict[str, Any]] = {}
    for i in range(days):
        d = first_day + timedelta(days=i)
        days_out[d] = {"date": d.isoformat(), "runs": 0, "experiments": 0, "equivCostUsd": 0.0, "tokens": 0}
    for run in runs:
        bucket = days_out.get(run["_day"])
        if bucket is None:
            continue
        bucket["runs"] += 1
        bucket["experiments"] += run["experiments"]
        bucket["equivCostUsd"] += run["equivCostUsd"]
        bucket["tokens"] += run["tokens"]

    quality = [
        {
            "runId": r["id"],
            "dataset": r["dataset"],
            "metric": r["metric"],
            "cv": r["bestCv"],
            "test": r["testScore"],
            "gap": r["optimismGap"],
        }
        for r in runs
        if r["status"] == "finished"
        and r["testScore"] is not None
        and r["bestCv"] is not None
        and r["optimismGap"] is not None
    ][:QUALITY_POINTS]

    metric_counts: dict[str, int] = {}
    for run in runs:
        if run["metric"]:
            metric_counts[run["metric"]] = metric_counts.get(run["metric"], 0) + 1

    return {
        "summary": summary,
        "series": list(days_out.values()),
        "recentRuns": [{k: v for k, v in r.items() if not k.startswith("_")} for r in runs[:RECENT_RUNS]],
        "quality": quality,
        "metrics": [{"metric": m, "runs": n} for m, n in sorted(metric_counts.items(), key=lambda kv: (-kv[1], kv[0]))],
        "providers": [
            {
                "model": p["model"],
                "calls": p["calls"],
                "tokens": int(p["tokens_in"]) + int(p["tokens_out"]),
                "equivCostUsd": equiv_cost(int(p["tokens_in"]), int(p["tokens_out"])),
            }
            for p in providers
        ],
        "pricing": dict(PRICING),
    }
