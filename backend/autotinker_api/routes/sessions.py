"""Sessions: the caller's list, one session with its messages and every run's events, rename, and messages typed into
a session (chat, steering, graceful stop)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from autotinker_api import db, repo, validation, watchdog
from autotinker_api.http import ApiError, json_ok, owner_of, read_json
from autotinker_api.runners import get_runner

router = APIRouter()

UNAVAILABLE = "Saved sessions are unavailable right now. Try again in a minute."
NOT_HERE = "This session doesn't exist in this browser."
STOP_ACK = (
    "Stopping after the current experiment. Then the best model is scored once on the locked test and the report "
    "is written."
)


@router.get("/api/sessions")
async def list_sessions(request: Request) -> JSONResponse:
    """The caller's sessions, newest first, each with its latest run's status and best score."""
    owner = owner_of(request)
    if not owner:
        return json_ok({"sessions": []})
    try:
        async with db.connection() as conn:
            return json_ok({"sessions": await repo.list_sessions(conn, owner)})
    except db.DatabaseUnavailable:
        raise ApiError(503, "Saved sessions are unavailable right now. Runs still work.", sessions=[]) from None


@router.get("/api/sessions/{session_id}")
async def get_session(session_id: str, request: Request) -> JSONResponse:
    """One session: its messages and every run with all of its events, for a full reload/resume."""
    async with db.connection() as conn:
        s = await repo.owned_session(conn, session_id, owner_of(request))
        if s is None:
            raise ApiError(404, NOT_HERE)
        messages = await repo.list_messages(conn, session_id)
        runs = await repo.list_runs(conn, session_id)
        runs = [await watchdog.enforce(conn, r) if r["status"] in repo.ACTIVE else r for r in runs]
        events = await repo.read_events_for_runs(conn, [r["id"] for r in runs])
        return json_ok(
            {
                "session": {
                    "id": s["id"],
                    "title": s["title"],
                    "createdAt": repo.iso(s["created_at"]),
                    "updatedAt": repo.iso(s["updated_at"]),
                },
                "messages": messages,
                "runs": [
                    {"row": repo.public_run_row(r), "meta": repo.public_meta(r), "events": events.get(r["id"], [])}
                    for r in runs
                ],
            }
        )


@router.patch("/api/sessions/{session_id}")
async def rename(session_id: str, request: Request) -> JSONResponse:
    body = await read_json(request, "Expected JSON: {title}.")
    title = " ".join(str(body.get("title") or "").split())
    if not title:
        raise ApiError(400, "A session needs a name.", field="title")
    if len(title) > 80:
        raise ApiError(400, "Keep the name under 80 characters.", field="title")
    owner = owner_of(request)
    async with db.connection() as conn:
        if not owner or not await repo.rename_session(conn, session_id, owner, title):
            raise ApiError(404, NOT_HERE)
    return json_ok({"title": title})


@router.post("/api/sessions/{session_id}/messages")
async def post_message(session_id: str, request: Request) -> JSONResponse:
    """Body {text} or {kind: "stop"} (the Stop button). Classified again here: during a run "stop" is a graceful stop
    and anything else steers the Planner; without a run it's plain chat. A steer is acknowledged by the engine's
    `steer_applied` event, not here."""
    body = await read_json(request, 'Expected JSON: {text} or {kind: "stop"}.')
    raw = body.get("text")
    text = raw.strip() if isinstance(raw, str) else ""
    wants_stop = body.get("kind") == "stop"
    if not wants_stop and not text:
        raise ApiError(400, "Type a message first.", field="text")
    if len(text) > validation.MAX_MESSAGE_CHARS:
        raise ApiError(400, f"Keep messages under {validation.MAX_MESSAGE_CHARS} characters.", field="text")

    try:
        async with db.connection() as conn:
            return await _handle_message(conn, session_id, owner_of(request), text, wants_stop)
    except db.DatabaseUnavailable:
        raise ApiError(503, "Saved sessions are unavailable right now, so messages can't be sent.") from None


async def _handle_message(
    conn: db.Conn, session_id: str, owner: str | None, text: str, wants_stop: bool
) -> JSONResponse:
    session = await repo.owned_session(conn, session_id, owner)
    if session is None:
        raise ApiError(404, NOT_HERE)
    run: dict[str, Any] | None = None
    if session["last_run_id"]:
        run = await repo.get_run(conn, session["last_run_id"])
        if run is not None:
            run = await watchdog.enforce(conn, run)
    active = run is not None and run["status"] in repo.ACTIVE
    if wants_stop:
        intent, clean = "control", "stop"
    else:
        intent, clean = validation.classify_message(text, run_active=active)
    if intent == "control" and not active:
        raise ApiError(409, "Nothing is running in this session.")
    # Once the engine has decided to stop it is scoring the locked test / writing the report; a stop or a steer would
    # only risk cancelling a run that is about to finish on its own.
    if intent != "chat" and run is not None and await repo.has_event(conn, run["id"], "stopped"):
        raise ApiError(409, "The run has already stopped: it's scoring the locked test and writing the report.")

    run_id = run["id"] if active and run is not None else None
    out = [
        await repo.insert_message(
            conn,
            session_id=session_id,
            run_id=run_id,
            role="user",
            text=(text or "Stop") if intent == "control" else clean,
            kind=intent,
        )
    ]

    async def system(msg: str, kind: str, rid: str | None = run_id) -> None:
        out.append(
            await repo.insert_message(conn, session_id=session_id, run_id=rid, role="system", text=msg, kind=kind)
        )

    delivered = False
    if intent == "control" and run is not None:
        runner = get_runner(run["runner"])
        delivered = await runner.control(run, {"type": "stop"})
        if delivered:
            await system(STOP_ACK, "control")
        else:
            # No control channel (the engine process is gone, or the sandbox can't be reached): stop it the hard way.
            await runner.cancel(run)
            await repo.finish_run(conn, run["id"], "cancelled", error="Cancelled by user.")
            await system(
                "The engine couldn't take a graceful stop, so the run was cancelled. Everything up to now is kept; "
                "there is no locked-test score.",
                "control",
            )
    elif intent == "steer" and run is not None:
        delivered = await get_runner(run["runner"]).control(run, {"type": "steer", "text": clean})
        if not delivered:
            await system("The engine couldn't be reached, so this wasn't passed on to the agents.", "steer")
    elif intent == "chat":
        await system(
            "Nothing is running here right now. Paste a link to a CSV to start another run in this session.",
            "chat",
            None,
        )
    return json_ok({"messages": out, "intent": intent, "delivered": delivered}, status=201)
