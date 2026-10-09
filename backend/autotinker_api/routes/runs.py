"""Runs: start, read (events after a seq), stream (SSE), cancel, the run's files, and the sandbox's event ingest."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import tempfile
import time
import zipfile
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.datastructures import UploadFile

from autotinker_api import (
    assets,
    background,
    blob,
    db,
    failures,
    ratelimit,
    repo,
    settings,
    urlguard,
    validation,
    watchdog,
)
from autotinker_api.events import parse_lines
from autotinker_api.http import ApiError, json_ok, owner_of, public_base, read_json
from autotinker_api.preview.service import PreviewError, check_url, peek_preview
from autotinker_api.runners import get_runner
from autotinker_api.runners.base import StartRequest, exit_status

router = APIRouter()
log = logging.getLogger("autotinker.runs")

NOT_FOUND = "No such run."
MAX_INGEST_BYTES = 8 * 1024 * 1024
POLL_S = 0.5
HEARTBEAT_S = 15.0
WATCHDOG_EVERY_S = 5.0


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


# ------------------------------------------------------------------------------------------------------- start


def _check_url_target(url: str, target: str) -> None:
    """Reject a target that can't be learned, from the link preview's column stats when this instance has them cached
    (the setup form previews the link just before Start). No refetch: without a cached preview the engine profiles
    the file itself."""
    preview = peek_preview(url)
    if not preview:
        return
    try:
        validation.check_target(preview["stats"], target)
    except validation.Invalid as e:
        raise ApiError(400, e.error, field=e.field) from None


async def _parse_start(request: Request) -> tuple[dict[str, Any], validation.RunOptions, bytes | None, str | None, str]:
    """(source fields, options, csv, sessionId, sentence) from JSON {url, ...} or multipart {file, ...}."""
    ctype = (request.headers.get("content-type") or "").lower()
    if "application/json" in ctype:
        body = await read_json(request, "Expected JSON: {url, target, metric?, goal?, maxExperiments}.")
        sid = body.get("sessionId")
        sentence = body.get("sentence")
        try:
            url = validation.validate_url(str(body.get("url") or ""))
            csv_format = validation.validate_csv_format(body.get("csvFormat"))
            opts = validation.validate_run_options(
                target=str(body.get("target") or ""),
                goal=str(body.get("goal") or ""),
                metric=None if body.get("metric") is None else str(body.get("metric")),
                max_experiments=body.get("maxExperiments", validation.DEFAULT_EXPERIMENTS),
            )
        except validation.Invalid as e:
            raise ApiError(400, e.error, field=e.field) from None
        resolved = urlguard.rewrite_share_link(url)
        try:  # fail fast on private/blocked hosts (the engine re-checks every hop when it downloads)
            await check_url(resolved)
        except PreviewError as e:
            raise ApiError(400, e.message, field="url") from None
        _check_url_target(resolved, opts.target)
        source = {
            "source": "url",
            "source_url": resolved,
            "file_name": validation.file_name_from_url(resolved),
            "file_bytes": 0,
            "csv_format": csv_format,
        }
        return (
            source,
            opts,
            None,
            sid if isinstance(sid, str) and sid else None,
            sentence[:600] if isinstance(sentence, str) else "",
        )
    try:
        form = await request.form(max_part_size=validation.MAX_UPLOAD_BYTES + 1024)
    except Exception:  # noqa: BLE001 - malformed multipart
        raise ApiError(400, "Send JSON with a link, or a multipart form with a CSV file.") from None
    file = form.get("file")
    if not isinstance(file, UploadFile):
        raise ApiError(400, "Attach a CSV file.", field="file")
    data = await file.read(validation.MAX_UPLOAD_BYTES + 1)
    try:
        columns = validation.validate_upload(file_name=file.filename or "", data=data)
        opts = validation.validate_run_options(
            target=str(form.get("target") or ""),
            goal=str(form.get("goal") or form.get("description") or ""),
            metric=str(form.get("metric")) if form.get("metric") else None,
            max_experiments=str(form.get("maxExperiments") or validation.DEFAULT_EXPERIMENTS),
            columns=columns,
        )
        validation.validate_upload_target(data, opts.target)
    except validation.Invalid as e:
        raise ApiError(400, e.error, field=e.field) from None
    sid = form.get("sessionId")
    source = {
        "source": "file",
        "source_url": None,
        "file_name": (file.filename or "")[:200],
        "file_bytes": len(data),
        "csv_format": validation.detect_csv_format(data),  # the server reads the whole upload: no need to trust a hint
    }
    return source, opts, data, str(sid) if sid else None, str(form.get("sentence") or "")[:600]


@router.post("/api/runs", status_code=201)
async def start_run(request: Request, background_tasks: BackgroundTasks) -> JSONResponse:
    """Start a live run. JSON {url, target, metric?, goal?, maxExperiments, sessionId?, sentence?} (the engine downloads
    the link itself) or multipart {file, ...same} (an uploaded CSV ≤ 5 MB). Without a sessionId a new session is
    created; `sentence` (the run as the user typed it) is stored as their chat message."""
    if not settings.live_runs_enabled():
        raise ApiError(503, "Live runs are switched off on this deployment. Watch a replay instead.")
    if int(request.headers.get("content-length") or 0) > validation.MAX_UPLOAD_BYTES + 64 * 1024:
        raise ApiError(413, "The upload is larger than 5 MB. Paste a link instead (up to 50 MB).", field="file")
    kind = settings.runner_kind()
    if kind == "local":
        from autotinker_api.runners.local import active_local_runs

        if active_local_runs() >= settings.env_int("AUTOTINKER_MAX_CONCURRENT_RUNS", 2):
            raise ApiError(
                429, "The server is busy with other runs. Try again in a few minutes.", headers={"Retry-After": "120"}
            )

    source, opts, csv, req_session, sentence = await _parse_start(request)
    owner = owner_of(request)
    if not owner:
        raise ApiError(400, "Cookies are needed to keep your sessions; enable them for this site.")

    try:
        async with db.connection() as conn:
            session_id = req_session
            if session_id and await repo.owned_session(conn, session_id, owner) is None:
                raise ApiError(404, "That session doesn't exist in this browser.", field="sessionId")
            # Rate-limit only after validation, so a typo doesn't burn one of the visitor's runs.
            verdict = await ratelimit.check(
                conn, ratelimit.run_limits(), {"ip": ratelimit.client_ip(request), "owner": owner}
            )
            if not verdict.ok:
                raise ApiError(
                    429,
                    "You've started the maximum number of live runs for now. "
                    f"Try again in {max(1, -(-verdict.retry_after_s // 60))} min.",
                    headers={"Retry-After": str(verdict.retry_after_s)},
                )
            await watchdog.sweep(conn)
            if not session_id:
                session_id = repo.new_session_id()
                title = validation.session_title(goal=opts.goal, target=opts.target, file_name=source["file_name"])
                await repo.create_session(conn, session_id=session_id, owner_id=owner, title=title)
            run_id = repo.new_run_id()
            token = secrets.token_urlsafe(32)
            if kind == "sandbox":
                from autotinker_api.runners.sandbox import deadline_for_new_run

                deadline = deadline_for_new_run()
            else:
                deadline = datetime.now(UTC) + timedelta(
                    seconds=settings.env_int("AUTOTINKER_RUN_TIMEOUT_S", 3600) + 60
                )
            await repo.insert_run(
                conn,
                {
                    "id": run_id,
                    "session_id": session_id,
                    "target": opts.target,
                    "metric": opts.metric,
                    "goal": opts.goal,
                    "max_experiments": opts.max_experiments,
                    "runner": kind,
                    "deadline_at": deadline,
                    **source,
                },
            )
            await repo.update_run(conn, run_id, ingest_token_sha256=sha256(token))
            if sentence.strip():
                await repo.insert_message(
                    conn, session_id=session_id, run_id=run_id, role="user", text=sentence.strip(), kind="chat"
                )
            run = await repo.get_run(conn, run_id)
            assert run is not None

            req = StartRequest(
                run=run, csv=csv, ingest_url=f"{public_base(request)}/api/runs/{run_id}/ingest", ingest_token=token
            )
            runner = get_runner(kind)
            if kind == "local":
                try:
                    await runner.start(req)
                except Exception as e:  # noqa: BLE001
                    log.error("[run %s] start failed: %s", run_id, type(e).__name__)
                    await repo.finish_run(conn, run_id, "failed", error="Could not start the run.")
            else:
                task, registered = background.spawn(runner.start(req), name=f"start-{run_id}")
                if background.needs_response_hold(registered):
                    background_tasks.add_task(background.join, task)
            fresh = await repo.get_run(conn, run_id) or run
    except db.DatabaseUnavailable:
        raise ApiError(503, "Runs need the database, and it is unavailable right now. Try again in a minute.") from None
    return json_ok({"id": run_id, "sessionId": session_id, "meta": repo.public_meta(fresh)}, status=201)


# ------------------------------------------------------------------------------------------------------- read


async def _owned(conn: db.Conn, run_id: str, request: Request) -> dict[str, Any]:
    run = await repo.owned_run(conn, run_id, owner_of(request))
    if run is None:
        raise ApiError(404, NOT_FOUND)
    return run


@router.get("/api/runs/{run_id}")
async def get_run(run_id: str, request: Request, after: int = -1) -> JSONResponse:
    """Meta + events with seq > `after` (+ the engine's run.json once written)."""
    async with db.connection() as conn:
        run = await watchdog.enforce(conn, await _owned(conn, run_id, request))
        events = await repo.read_events(conn, run_id, after)
    return json_ok({"meta": repo.public_meta(run), "events": events, "record": run.get("record")})


def _sse(data: Any, *, event: str | None = None, event_id: int | None = None) -> str:
    head = (f"event: {event}\n" if event else "") + (f"id: {event_id}\n" if event_id is not None else "")
    return f"{head}data: {json.dumps(data, separators=(',', ':'))}\n\n"


@router.get("/api/runs/{run_id}/stream")
async def stream(run_id: str, request: Request) -> StreamingResponse:
    """Server-Sent Events: replays stored events (seq > Last-Event-ID / ?after), then tails Postgres.
        event: meta  — run status changes (data = public meta)
        (default)    — one run event per message, id = seq
        event: end   — the run is terminal and every event has been sent; the client should close.
    A connection lasts at most AUTOTINKER_SSE_MAX_S (default 280 s, under the function's 300 s limit); the browser's
    EventSource reconnects with Last-Event-ID and the stream resumes where it left off."""
    async with db.connection() as conn:
        await _owned(conn, run_id, request)
    resume = request.headers.get("last-event-id") or request.query_params.get("after")
    try:
        last_seq = int(resume) if resume is not None else -1
    except ValueError:
        last_seq = -1
    max_s = settings.env_int("AUTOTINKER_SSE_MAX_S", 280)

    async def gen() -> AsyncIterator[str]:
        nonlocal last_seq
        yield "retry: 2000\n\n"
        began = last_beat = last_dog = time.monotonic()
        last_key = ""
        try:
            async with db.connection() as conn:  # one connection for the stream's lifetime
                while True:
                    if await request.is_disconnected():
                        return
                    run = await repo.get_run(conn, run_id)
                    if run is None:
                        return
                    now = time.monotonic()
                    if now - last_dog >= WATCHDOG_EVERY_S:
                        run = await watchdog.enforce(conn, run)
                        last_dog = now
                    key = f"{run['status']}|{run['updated_at']}"
                    if key != last_key:
                        last_key = key
                        yield _sse(repo.public_meta(run), event="meta")
                    events = await repo.read_events(conn, run_id, last_seq, limit=500)
                    for ev in events:
                        last_seq = int(ev["seq"])
                        yield _sse(ev, event_id=last_seq)
                    if repo.is_terminal(run["status"]) and not events:
                        yield "event: end\ndata: {}\n\n"
                        return
                    if now - last_beat > HEARTBEAT_S:
                        yield ": keep-alive\n\n"
                        last_beat = now
                    if now - began > max_s:
                        return
                    if len(events) < 500:
                        await asyncio.sleep(POLL_S)
        except db.DatabaseUnavailable:
            return

    return StreamingResponse(
        gen(),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-store, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# ------------------------------------------------------------------------------------------------------ cancel


@router.post("/api/runs/{run_id}/cancel")
async def cancel(run_id: str, request: Request) -> JSONResponse:
    """Cancel at once (kills the engine; no locked test, no report). The session UI's Stop is graceful instead
    (POST /api/sessions/{id}/messages) and only falls back to this."""
    async with db.connection() as conn:
        run = await _owned(conn, run_id, request)
        if repo.is_terminal(run["status"]):
            return json_ok({"meta": repo.public_meta(run), "cancelled": False})
        try:
            await get_runner(run["runner"]).cancel(run)
        except Exception as e:  # noqa: BLE001
            log.error("[run %s] cancel failed: %s", run_id, type(e).__name__)
        updated = await repo.finish_run(conn, run_id, "cancelled", error="Cancelled by user.")
        return json_ok({"meta": repo.public_meta({**run, **(updated or {})}), "cancelled": True})


# ------------------------------------------------------------------------------------------------------- files

NO_FILE = "No such file."


@router.get("/api/runs/{run_id}/assets")
async def list_assets(run_id: str, request: Request) -> JSONResponse:
    """The files the run produced (empty until the engine has announced them)."""
    from autotinker_api.runners.local import data_root

    async with db.connection() as conn:
        await _owned(conn, run_id, request)
        rows = await repo.list_assets(conn, run_id)
    root = data_root()
    return json_ok({"files": [assets.public_asset(run_id, r, root) for r in rows]})


@router.get("/api/runs/{run_id}/assets/{name}", response_model=None)
async def download_asset(run_id: str, name: str, request: Request, inline: int = 0) -> Response:
    """Blob: 302 to a presigned GET URL valid for a few minutes (the store is private; bytes never pass through this
    function). Local: the file itself, as an attachment.

    `?inline=1` (small text assets only: kinds code/script/text/json up to 1 MB): the bytes themselves, read here and
    served same-origin as text/plain or application/json, so the web previews work without the Blob origin's CORS."""
    from autotinker_api.runners.local import data_root

    async with db.connection() as conn:
        await _owned(conn, run_id, request)
        row = await repo.get_asset(conn, run_id, name) if assets.valid_name(name) else None
    if row is None:
        raise ApiError(404, NO_FILE)
    if row["storage"] == "skipped":
        raise ApiError(404, row["note"] or NO_FILE)
    if inline:
        return await _inline_asset(run_id, row, data_root())
    if row["storage"] == "local":
        path = assets.local_file(data_root(), row)
        if path is None:
            raise ApiError(404, "That file is no longer on this server.")
        return FileResponse(
            path,
            media_type=row["content_type"],
            filename=name,
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        )
    try:
        url = await assets.download_url(row)
    except blob.BlobError as e:
        log.error("[run %s] download link for %s failed: %s", run_id, name, e)
        raise ApiError(503, "The download link couldn't be created. Try again in a minute.") from None
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})


ZIP_CHUNK = 1024 * 1024


async def _inline_asset(run_id: str, row: dict[str, Any], root: Any) -> Response:
    if not assets.inline_ok(row):
        raise ApiError(415, "Only small text files can be previewed here; download it instead.")
    if row["storage"] == "local":
        path = assets.local_file(root, row)
        if path is None:
            raise ApiError(404, "That file is no longer on this server.")
        data = await asyncio.to_thread(path.read_bytes)
    else:
        try:
            data = await assets.read_blob(row)
        except (blob.BlobError, httpx.HTTPError) as e:
            log.error("[run %s] inline read of %s failed: %s", run_id, row["name"], type(e).__name__)
            raise ApiError(503, "The file couldn't be read right now. Try again in a minute.") from None
    if len(data) > assets.INLINE_MAX_BYTES:
        raise ApiError(415, "Only small text files can be previewed here; download it instead.")
    return Response(
        data,
        media_type=assets.inline_media_type(row),
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Content-Disposition": "inline",
        },
    )


@router.get("/api/runs/{run_id}/assets.zip", response_model=None)
async def download_assets_zip(run_id: str, request: Request) -> Response:
    """Every available file of the run in one zip, unpacking into autotinker-<run id>/ (model.joblib, predict.py,
    requirements.txt, model_card.json, pipeline.py). Owner-checked; built in a spooled temp file (large models spill
    to disk) and streamed out in 1 MB chunks. Files that can't be read are left out; none at all is a 404/503."""
    from autotinker_api.runners.local import data_root

    async with db.connection() as conn:
        await _owned(conn, run_id, request)
        rows = await repo.list_assets(conn, run_id)
    rows = [r for r in rows if r["storage"] in ("local", "blob") and assets.valid_name(r["name"])]
    if not rows:
        raise ApiError(404, "This run has no files to download yet.")
    folder = assets.zip_folder(run_id)
    spool = tempfile.SpooledTemporaryFile(max_size=32 * 1024 * 1024)  # noqa: SIM115 - closed by the stream
    added = 0
    with zipfile.ZipFile(spool, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for row in rows:
            arc = f"{folder}/{row['name']}"
            if row["storage"] == "local":
                path = assets.local_file(data_root(), row)
                if path is None:
                    continue
                await asyncio.to_thread(zf.write, path, arc)
            else:
                try:
                    data = await assets.read_blob(row)
                except (blob.BlobError, httpx.HTTPError) as e:
                    log.error("[run %s] zip: %s could not be read: %s", run_id, row["name"], type(e).__name__)
                    continue
                await asyncio.to_thread(zf.writestr, arc, data)
            added += 1
    if not added:
        spool.close()
        raise ApiError(503, "The files couldn't be read right now. Try again in a minute, or download them one by one.")
    size = spool.tell()
    spool.seek(0)

    async def chunks() -> AsyncIterator[bytes]:
        try:
            while chunk := await asyncio.to_thread(spool.read, ZIP_CHUNK):
                yield chunk
        finally:
            spool.close()

    return StreamingResponse(
        chunks(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{folder}.zip"',
            "Content-Length": str(size),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


# ------------------------------------------------------------------------------------------------------ ingest


@router.post("/api/runs/{run_id}/ingest")
async def ingest(run_id: str, request: Request) -> JSONResponse:
    """The sandbox's forward.py posts here with `X-Ingest-Token: <per-run token>` (only its sha256 is stored).
    Body: {"kind": "events", "lines": [...]} | {"kind": "heartbeat"} | {"kind": "record", "record": {...}}
        | {"kind": "exit", "exit_code": n, "stderr_tail": "..."}
        | {"kind": "asset_upload_url", "name", "bytes", "assetKind", "contentType"}
              → {"upload": {method, url, headers}, "pathname"} (a presigned Blob PUT) | {"skip": reason}
        | {"kind": "asset", "name", "bytes", "assetKind", "contentType", "status": "uploaded"|"skipped",
           "pathname"?, "url"?, "note"?}"""
    if int(request.headers.get("content-length") or 0) > MAX_INGEST_BYTES:
        raise ApiError(413, "Too large.")
    token = request.headers.get("x-ingest-token") or ""
    async with db.connection() as conn:
        run = await repo.get_run(conn, run_id)
        # Same answer for an unknown run and a wrong token: don't reveal which run ids exist.
        if (
            run is None
            or not token
            or not run["ingest_token_sha256"]
            or not hmac.compare_digest(sha256(token), run["ingest_token_sha256"])
        ):
            raise ApiError(401, "Bad ingest token.")
        body = await read_json(request, "Expected JSON.")
        kind = body.get("kind")
        if kind == "events":
            lines = body.get("lines") or []
            if not isinstance(lines, list):
                raise ApiError(400, "lines must be a list.")
            events = parse_lines(str(x) for x in lines[:2000])
            added = await repo.append_events(conn, run_id, events)
            return json_ok({"ok": True, "accepted": added, "skipped": len(lines) - len(events)})
        if kind == "heartbeat":
            await repo.touch_seen(conn, run_id)
            return json_ok({"ok": True})
        if kind == "record":
            record = body.get("record")
            if not isinstance(record, dict):
                raise ApiError(400, "record must be an object.")
            await repo.update_run(conn, run_id, record=record)
            return json_ok({"ok": True})
        if kind == "exit":
            code = body.get("exit_code")
            tail = settings.redact(str(body.get("stderr_tail") or ""))[-4000:]
            exit_code = code if isinstance(code, int) else None
            status, error = exit_status(code=exit_code, cancelled=False, has_record=run["record"] is not None)
            why = None
            if status == "failed":
                why = failures.describe(await repo.last_event(conn, run_id, "run_failed"), code=exit_code, tail=tail)
            await repo.finish_run(
                conn,
                run_id,
                status,
                error=why.message if why else error,
                error_tail=tail if status == "failed" else None,
                error_code=why.code if why else None,
                error_hint=why.hint if why else None,
            )
            # Nothing inside the VM can stop it; this final post is the hook.
            if run["runner"] == "sandbox" and run["runner_ref"]:
                await get_runner("sandbox").cancel(run)
                await repo.update_run(conn, run_id, timings={"sandbox_stopped_at": datetime.now(UTC).isoformat()})
            return json_ok({"ok": True})
        if kind == "asset_upload_url":
            return json_ok(await assets.upload_url(conn, run_id, body))
        if kind == "asset":
            return json_ok(await assets.register_uploaded(conn, run_id, body))
    raise ApiError(400, "Unknown kind.")
