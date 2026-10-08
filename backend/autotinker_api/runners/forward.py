"""Runs inside the sandbox VM (written there by sandbox.py as forward.py). Standard library only.

    autotinker run … --events-stdout | python forward.py --out /vercel/work/out
        streams the engine's JSONL to POST $INGEST_URL in small batches (≤ 1 s latency) with a heartbeat every minute;
        when the stream ends, uploads the files of the engine's `assets_ready` event (see upload_assets)
    python forward.py --final CODE OUT_DIR LOG…
        posts run.json, then the exit code and the tail of the logs (the exit post stops the VM)

Asset upload, per file: stat it → ask the API for a presigned PUT URL (`asset_upload_url`; the API refuses files over
its cap or when no Blob store is configured and records them as skipped) → PUT the bytes straight to Vercel Blob → tell
the API where they went (`asset`). A failed upload is registered as skipped with the reason. Files never pass through
the API (Vercel Functions take at most 4.5 MB per request).

The backend also imports `resolve_asset_path` from here for the local runner, so both runners agree on where files are.
"""

from __future__ import annotations

import glob
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

URL = ""
TOKEN = ""
PUT_ATTEMPTS = 3

PostJson = Callable[[dict[str, Any]], "dict[str, Any] | None"]
PutFile = Callable[[str, dict[str, str], str, int], "dict[str, Any]"]


class UploadError(Exception):
    pass


def log(msg: str) -> None:
    sys.stderr.write(f"[forward] {msg}\n")


def post_json(body: dict[str, Any], attempts: int = 6) -> dict[str, Any] | None:
    """POST to the ingest route; the parsed JSON reply, or None if every attempt failed."""
    data = json.dumps(body).encode()
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(
                URL, data=data, method="POST", headers={"Content-Type": "application/json", "X-Ingest-Token": TOKEN}
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
            try:
                out = json.loads(raw or b"{}")
            except ValueError:
                out = {}
            return out if isinstance(out, dict) else {}
        except urllib.error.HTTPError as e:
            log(f"ingest attempt {attempt + 1} failed: HTTP {e.code}")
            if 400 <= e.code < 500 and e.code != 429:
                return None  # a refusal; retrying won't help
        except Exception as e:  # noqa: BLE001
            log(f"ingest attempt {attempt + 1} failed: {e}")
        if attempt + 1 < attempts:
            time.sleep(min(2**attempt, 15))
    return None


def post(body: dict[str, Any], attempts: int = 6) -> bool:
    return post_json(body, attempts) is not None


# ------------------------------------------------------------------------------------------------------ assets


def resolve_asset_path(out_dir: str, engine_run_id: object, rel: object) -> str | None:
    """The real path of an asset the engine reported, or None. `rel` is relative to the engine's run dir, which is
    <out_dir>/<engine run id>; it must stay inside that run dir's assets/ folder (no absolute paths, no `..`, no
    symlinks out)."""
    if not isinstance(rel, str) or not rel or rel.startswith(("/", "\\")) or "\\" in rel or "\x00" in rel:
        return None
    bases: list[str] = []
    if isinstance(engine_run_id, str) and engine_run_id not in ("", ".", "..") and "/" not in engine_run_id:
        bases.append(os.path.join(out_dir, engine_run_id))
    for d in sorted(glob.glob(os.path.join(glob.escape(out_dir), "*"))):  # fallback: the only run dir under out/
        if os.path.isdir(d) and d not in bases:
            bases.append(d)
    for base in bases:
        assets = os.path.realpath(os.path.join(base, "assets"))
        path = os.path.realpath(os.path.join(base, rel))
        if path.startswith(assets + os.sep) and os.path.isfile(path):
            return path
    return None


def put_file(url: str, headers: dict[str, str], path: str, size: int) -> dict[str, Any]:
    """PUT a file (streamed from disk) to a presigned URL. The reply's JSON ({url, pathname, ...}) or {} if the blob
    was already there (an earlier attempt that got through)."""
    last = ""
    for attempt in range(PUT_ATTEMPTS):
        try:
            with open(path, "rb") as f:
                req = urllib.request.Request(
                    url, data=f, method="PUT", headers={**headers, "Content-Length": str(size)}
                )
                with urllib.request.urlopen(req, timeout=600) as r:
                    raw = r.read()
            try:
                out = json.loads(raw or b"{}")
            except ValueError:
                out = {}
            return out if isinstance(out, dict) else {}
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")[:500]
            except Exception:  # noqa: BLE001
                pass
            if "already exists" in body:
                return {}
            last = f"HTTP {e.code}"
            if 400 <= e.code < 500 and e.code != 429:
                break
        except Exception as e:  # noqa: BLE001
            last = type(e).__name__
        log(f"upload attempt {attempt + 1} failed: {last}")
        if attempt + 1 < PUT_ATTEMPTS:
            time.sleep(2**attempt)
    raise UploadError(last or "unknown error")


def upload_assets(
    event: dict[str, Any], out_dir: str, post_json: PostJson = post_json, put_file: PutFile = put_file
) -> list[str]:
    """Upload every file of an `assets_ready` event; returns one outcome per file (for the log)."""
    outcomes: list[str] = []
    files = event.get("files")
    for f in files if isinstance(files, list) else []:
        if not isinstance(f, dict) or not isinstance(f.get("name"), str):
            continue
        name = f["name"]
        meta = {
            "name": name,
            "assetKind": f.get("kind") if isinstance(f.get("kind"), str) else "file",
            "contentType": f.get("content_type") if isinstance(f.get("content_type"), str) else "",
        }
        path = resolve_asset_path(out_dir, event.get("run_id"), f.get("path"))
        if path is None:
            post_json({"kind": "asset", **meta, "status": "skipped", "bytes": 0, "note": "The file was not found."})
            outcomes.append(name + ": missing")
            continue
        size = os.path.getsize(path)
        reply = post_json({"kind": "asset_upload_url", **meta, "bytes": size})
        if reply is None:
            outcomes.append(name + ": no upload url")
            continue
        upload = reply.get("upload")
        if not isinstance(upload, dict):
            outcomes.append(name + ": skipped ({})".format(reply.get("skip", "refused")))
            continue
        try:
            result = put_file(str(upload["url"]), dict(upload.get("headers") or {}), path, size)
        except UploadError as e:
            note = f"Upload failed ({e})."
            post_json({"kind": "asset", **meta, "status": "skipped", "bytes": size, "note": note})
            outcomes.append(name + ": upload failed")
            continue
        post_json(
            {
                "kind": "asset",
                **meta,
                "status": "uploaded",
                "bytes": size,
                "pathname": reply.get("pathname"),
                "url": result.get("url"),
            }
        )
        outcomes.append(name + ": uploaded")
    return outcomes


def assets_event(line: str) -> dict[str, Any] | None:
    if '"assets_ready"' not in line:
        return None
    try:
        ev = json.loads(line)
    except ValueError:
        return None
    return ev if isinstance(ev, dict) and ev.get("type") == "assets_ready" else None


# ------------------------------------------------------------------------------------------------- stream/final


def final(code: str, out_dir: str, logs: list[str]) -> None:
    paths = [os.path.join(out_dir, "run.json")] + sorted(glob.glob(os.path.join(out_dir, "*", "run.json")))
    for p in paths:
        if os.path.isfile(p):
            try:
                with open(p) as fh:
                    post({"kind": "record", "record": json.load(fh)})
            except ValueError:
                pass
            break
    tail: list[str] = []
    for p in logs:
        try:
            with open(p, errors="replace") as fh:
                tail += fh.read().splitlines()[-30:]
        except OSError:
            pass
    post({"kind": "exit", "exit_code": int(code), "stderr_tail": "\n".join(tail[-60:])})


def heartbeat() -> None:
    while True:
        time.sleep(60)
        post({"kind": "heartbeat"}, attempts=1)


def stream(out_dir: str | None) -> None:
    q: queue.Queue[str | None] = queue.Queue()

    def reader() -> None:
        for line in sys.stdin:
            if line.strip():
                q.put(line.rstrip("\n"))
        q.put(None)

    threading.Thread(target=reader, daemon=True).start()
    threading.Thread(target=heartbeat, daemon=True).start()
    buf: list[str] = []
    last, done = time.monotonic(), False
    assets: dict[str, Any] | None = None
    while not done:
        try:
            item = q.get(timeout=0.5)
            if item is None:
                done = True
            else:
                buf.append(item)
                assets = assets_event(item) or assets
        except queue.Empty:
            pass
        if buf and (done or len(buf) >= 50 or time.monotonic() - last >= 1.0):
            post({"kind": "events", "lines": buf})
            buf, last = [], time.monotonic()
    if assets is not None and out_dir:
        # Before --final posts the exit (which stops the VM); the heartbeat thread keeps the run alive meanwhile.
        for outcome in upload_assets(assets, out_dir):
            log(outcome)


def main(argv: list[str]) -> None:
    global URL, TOKEN
    URL = os.environ["INGEST_URL"]
    TOKEN = os.environ["INGEST_TOKEN"]
    if argv[:1] == ["--final"]:
        final(argv[1], argv[2], argv[3:])
    else:
        stream(argv[1] if argv[:1] == ["--out"] and len(argv) > 1 else None)


if __name__ == "__main__":
    main(sys.argv[1:])
