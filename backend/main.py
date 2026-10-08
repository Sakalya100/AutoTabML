"""SPIKE: FastAPI service that runs AutoTinker in a Vercel Sandbox and relays its event stream.

Routes live under /py/* so they never clash with the Next.js app's /api routes (see the root vercel.json).
See runner.py for the sandbox lifecycle and the secret-handling rules.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from vercel.headers import set_headers

from runner import SandboxRunner, StartError
from store import MemoryStore, PostgresStore, Store, now_iso

app = FastAPI(title="autotinker-spike", docs_url="/py/docs", openapi_url="/py/openapi.json")

_store: Store | None = None
_runner: Any = None

TERMINAL = {"finished", "failed", "cancelled"}
SECRET_PATTERNS = re.compile(r"(gsk_[A-Za-z0-9]+|AIza[0-9A-Za-z_\-]+|AQ\.[A-Za-z0-9_\-\.]+|csk-[A-Za-z0-9]+|"
                             r"npg_[A-Za-z0-9]+|Bearer\s+\S+)")


def get_store() -> Store:
    global _store
    if _store is None:
        dsn = os.environ.get("DATABASE_URL_POOLED") or os.environ.get("DATABASE_URL")
        _store = PostgresStore(dsn) if dsn else MemoryStore()
    return _store


def get_runner() -> Any:
    global _runner
    if _runner is None:
        _runner = SandboxRunner()
    return _runner


@app.middleware("http")
async def vercel_request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
    # The Sandbox SDK reads the per-request OIDC token (x-vercel-oidc-token) from this context.
    set_headers(dict(request.headers))
    return await call_next(request)


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def redact(text: str) -> str:
    return SECRET_PATTERNS.sub("[redacted]", text)


def public_base(request: Request) -> str:
    explicit = os.environ.get("AUTOTINKER_PUBLIC_URL")
    if explicit:
        return explicit.rstrip("/")
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    proto = request.headers.get("x-forwarded-proto") or ("http" if host.startswith("localhost") else "https")
    return f"{proto}://{host}"


# ---------------------------------------------------------------------------------------------------------- routes


@app.get("/py/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "store": type(get_store()).__name__,
        "providers": [k for k in ("GROQ_API_KEY", "GEMINI_API_KEY") if os.environ.get(k)],
        "bypass_configured": bool(os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET")),
        "region": os.environ.get("VERCEL_REGION"),
    }


class StartRun(BaseModel):
    url: str
    target: str = Field(min_length=1, max_length=200)
    max_experiments: int = Field(default=3, ge=1, le=3)

    @field_validator("url")
    @classmethod
    def https_only(cls, v: str) -> str:
        parts = urlsplit(v)
        if parts.scheme != "https" or not parts.hostname:
            raise ValueError("url must be an https:// link")
        return v


@app.post("/py/runs", status_code=201)
async def start_run(body: StartRun, request: Request) -> dict[str, Any]:
    store = get_store()
    run_id = secrets.token_hex(6)
    token = secrets.token_urlsafe(32)
    await store.create_run(
        {"id": run_id, "url": body.url, "target": body.target, "max_experiments": body.max_experiments,
         "status": "starting", "token_sha256": sha256(token), "timings": {"requested_at": now_iso()}}
    )
    ingest_url = f"{public_base(request)}/py/runs/{run_id}/ingest"
    t0 = time.monotonic()
    try:
        res = await get_runner().start(
            run_id=run_id, url=body.url, target=body.target, max_experiments=body.max_experiments,
            ingest_url=ingest_url, token=token,
        )
    except StartError as exc:
        await store.update_run(run_id, status="failed", error=str(exc), error_tail=redact(exc.tail),
                               sandbox_name=exc.sandbox_name, timings={"finished_at": now_iso()})
        raise HTTPException(502, {"id": run_id, "error": str(exc)}) from exc
    timings = {
        "sandbox_create_s": round(res.create_s, 2),
        "install_s": round(res.install_s, 2),
        "start_s": round(res.start_s, 2),
        "start_request_s": round(time.monotonic() - t0, 2),
        "run_started_at": now_iso(),
    }
    await store.update_run(run_id, status="running", sandbox_name=res.sandbox_name, session_id=res.session_id,
                           timings=timings)
    return {"id": run_id, "status": "running", "sandbox": res.sandbox_name, "timings": timings}


class Ingest(BaseModel):
    kind: str
    lines: list[str] = []
    exit_code: int | None = None
    stderr_tail: str = ""


@app.post("/py/runs/{run_id}/ingest")
async def ingest(run_id: str, body: Ingest, x_ingest_token: str = Header(default="")) -> dict[str, Any]:
    store = get_store()
    run = await store.get_run(run_id)
    # Same response for unknown run and wrong token: don't reveal which run ids exist.
    if run is None or not hmac.compare_digest(sha256(x_ingest_token), run["token_sha256"]):
        raise HTTPException(401, "bad ingest token")
    if body.kind == "events":
        events: list[tuple[int, dict[str, Any]]] = []
        for line in body.lines[:500]:
            try:
                ev = json.loads(line)
                events.append((int(ev["seq"]), ev))
            except (ValueError, KeyError, TypeError):
                continue
        added = await store.add_events(run_id, events)
        if added and "first_event_at" not in (run.get("timings") or {}):
            await store.update_run(run_id, timings={"first_event_at": now_iso()})
        return {"ok": True, "accepted": added, "skipped": len(body.lines) - len(events)}
    if body.kind == "exit":
        status = run["status"] if run["status"] == "cancelled" else (
            "finished" if body.exit_code == 0 else "failed")
        await store.update_run(run_id, status=status, exit_code=body.exit_code,
                               error_tail=redact(body.stderr_tail)[-4000:] or None,
                               timings={"finished_at": now_iso()})
        if run.get("sandbox_name"):
            # Nothing inside the VM can stop it; this final post is the hook. (Runs after the response is built,
            # but within this request, so the forwarder's retries cover a failure here.)
            try:
                await get_runner().cancel(run["sandbox_name"])
                await store.update_run(run_id, timings={"sandbox_stopped_at": now_iso()})
            except Exception as exc:  # noqa: BLE001
                await store.update_run(run_id, error=f"sandbox stop failed: {type(exc).__name__}")
        return {"ok": True}
    raise HTTPException(400, "unknown kind")


@app.get("/py/runs/{run_id}")
async def get_run(run_id: str, after: int = 0, limit: int = 500) -> dict[str, Any]:
    store = get_store()
    run = await store.get_run(run_id)
    if run is None:
        raise HTTPException(404, "no such run")
    run.pop("token_sha256", None)
    events = await store.get_events(run_id, after, min(max(limit, 1), 1000))
    next_after = int(events[-1]["seq"]) if events else after
    return {"run": run, "events": events, "next_after": next_after}


class StopRun(BaseModel):
    hard: bool = False


@app.post("/py/runs/{run_id}/stop")
async def stop_run(run_id: str, body: StopRun | None = None) -> dict[str, Any]:
    store = get_store()
    run = await store.get_run(run_id)
    if run is None:
        raise HTTPException(404, "no such run")
    if run["status"] in TERMINAL:
        return {"ok": True, "status": run["status"], "note": "already finished"}
    name = run.get("sandbox_name")
    if not name:
        raise HTTPException(409, "run has no sandbox yet")
    hard = bool(body and body.hard)
    if hard:
        await get_runner().cancel(name)
        await store.update_run(run_id, status="cancelled",
                               timings={"cancelled_at": now_iso(), "sandbox_stopped_at": now_iso()})
        return {"ok": True, "status": "cancelled"}
    await get_runner().request_stop(name)
    await store.update_run(run_id, timings={"stop_requested_at": now_iso()})
    return {"ok": True, "status": run["status"], "note": "stop requested; the engine finishes the current step"}


@app.get("/py/runs/{run_id}/usage")
async def usage(run_id: str) -> dict[str, Any]:
    run = await get_store().get_run(run_id)
    if run is None or not run.get("sandbox_name"):
        raise HTTPException(404, "no such run")
    return await get_runner().usage(run["sandbox_name"])
