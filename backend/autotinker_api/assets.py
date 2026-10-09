"""A run's downloadable files (the trained model, the pipeline code), announced by the engine's `assets_ready` event.

    {"type": "assets_ready", "run_id": <engine run id>, "files": [
        {"name": "model.joblib", "path": "assets/model.joblib", "bytes": 123, "kind": "model",
         "content_type": "application/octet-stream"}, ...]}

`path` is relative to the engine's run dir, <--out>/<engine run id>/, and must stay inside its assets/ folder.

Where the bytes go:
    sandbox runs   forward.py (in the VM) uploads each file to Vercel Blob with a presigned PUT URL the ingest route
                   issues (`asset_upload_url`), then registers it (`asset`). See runners/forward.py.
    local runs     the runner reads the files after the engine exits: uploaded to Blob when BLOB_READ_WRITE_TOKEN is
                   set (kept on disk if that upload fails), else kept on disk and served from there.
Files over AUTOTINKER_MAX_ASSET_MB (default 100) are registered as `skipped` with the reason, as are files the
engine reported but didn't write. The store is private: downloads go through the owner-checked
GET /api/runs/{id}/assets/{name}, which redirects to a presigned GET URL valid for a few minutes.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from autotinker_api import blob, repo, settings
from autotinker_api.db import Conn
from autotinker_api.runners.forward import resolve_asset_path

log = logging.getLogger("autotinker.assets")

MAX_ASSETS_PER_RUN = 20
UPLOAD_URL_TTL_S = 15 * 60
DOWNLOAD_URL_TTL_S = 5 * 60
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
_KIND = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_CTYPE = re.compile(r"^[A-Za-z0-9][\w.+-]*/[\w.+-]+$")


def max_bytes() -> int:
    return max(1, settings.env_int("AUTOTINKER_MAX_ASSET_MB", 100)) * 1024 * 1024


def valid_name(name: object) -> bool:
    return isinstance(name, str) and bool(_NAME.match(name)) and ".." not in name


def clean_kind(kind: object) -> str:
    return kind if isinstance(kind, str) and _KIND.match(kind) else "file"


def clean_content_type(ct: object) -> str:
    return ct if isinstance(ct, str) and len(ct) <= 100 and _CTYPE.match(ct) else "application/octet-stream"


def blob_pathname(run_id: str, name: str) -> str:
    return f"runs/{run_id}/{name}"


def too_large_note(size: int) -> str:
    return f"Not saved: {size / 1024 / 1024:.0f} MB is over the {max_bytes() // (1024 * 1024)} MB limit for downloads."


NOT_CONFIGURED_NOTE = "Not saved: file storage isn't configured on this server."


def public_asset(run_id: str, row: dict[str, Any], data_root: Path | None = None) -> dict[str, Any]:
    available = row["storage"] == "blob"
    if row["storage"] == "local" and data_root is not None:
        available = local_file(data_root, row) is not None
    return {
        "name": row["name"],
        "kind": row["kind"],
        "bytes": int(row["bytes"] or 0),
        "contentType": row["content_type"],
        "downloadUrl": f"/api/runs/{run_id}/assets/{row['name']}",
        "available": available,
        "note": row["note"],
    }


def local_file(data_root: Path, row: dict[str, Any]) -> Path | None:
    rel = row.get("local_path")
    if not rel:
        return None
    root = data_root.resolve()
    path = (root / rel).resolve()
    return path if path.is_relative_to(root) and path.is_file() else None


async def register_local(
    conn: Conn, run_id: str, event: dict[str, Any], out_dir: Path, data_root: Path
) -> list[dict[str, Any]]:
    """The local runner's half: register (and, with a Blob token, upload) every file of an `assets_ready` event."""
    files = event.get("files")
    done: list[dict[str, Any]] = []
    for f in (files if isinstance(files, list) else [])[:MAX_ASSETS_PER_RUN]:
        if not isinstance(f, dict) or not valid_name(f.get("name")):
            continue
        name = str(f["name"])
        ctype = clean_content_type(f.get("content_type"))
        meta: dict[str, Any] = {"kind": clean_kind(f.get("kind")), "content_type": ctype}
        found = resolve_asset_path(str(out_dir), event.get("run_id"), f.get("path"))
        if found is None:
            row = {**meta, "storage": "skipped", "bytes": 0, "note": "Not saved: the engine didn't write this file."}
        else:
            path = Path(found)
            size = path.stat().st_size
            row = {**meta, "bytes": size}
            if size > max_bytes():
                row.update(storage="skipped", note=too_large_note(size))
            else:
                try:
                    row.update(storage="local", local_path=str(path.relative_to(data_root.resolve())))
                except ValueError:  # outside the data dir (never for the local runner): not servable from disk
                    row.update(storage="skipped", note="Not saved: the file is outside the data directory.")
                if blob.configured() and row["storage"] == "local":
                    try:
                        put = await blob.put_private(blob_pathname(run_id, name), path.read_bytes(), ctype)
                        row.update(
                            storage="blob",
                            blob_url=put["url"],
                            blob_pathname=put.get("pathname") or blob_pathname(run_id, name),
                            local_path=None,
                        )
                    except blob.BlobError as e:
                        log.warning("[run %s] blob upload of %s failed (%s); keeping it on disk", run_id, name, e)
        await repo.upsert_asset(conn, run_id, name, **row)
        done.append({"name": name, **row})
    return done


# ------------------------------------------------------------------------------------------- the sandbox's ingest


async def upload_url(conn: Conn, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """`asset_upload_url`: a presigned PUT for runs/<run_id>/<name>, or {"skip": reason} (recorded as skipped)."""
    name = body.get("name")
    if not valid_name(name):
        return {"ok": False, "skip": "invalid name"}
    assert isinstance(name, str)
    size = body.get("bytes")
    size = size if isinstance(size, int) and size >= 0 else 0
    meta = {"kind": clean_kind(body.get("assetKind")), "content_type": clean_content_type(body.get("contentType"))}
    if await repo.get_asset(conn, run_id, name) is None and await repo.count_assets(conn, run_id) >= MAX_ASSETS_PER_RUN:
        return {"ok": False, "skip": "too many files"}
    note: str | None = None
    if size > max_bytes():
        note = too_large_note(size)
    elif not blob.configured():
        note = NOT_CONFIGURED_NOTE
    else:
        pathname = blob_pathname(run_id, name)
        try:
            signed = await blob.issue_signed_token(
                pathname, ["put"], ttl_s=UPLOAD_URL_TTL_S, maximum_size_in_bytes=max_bytes()
            )
            return {
                "ok": True,
                "pathname": pathname,
                "upload": blob.presigned_put(signed, pathname, meta["content_type"]),
            }
        except blob.BlobError as e:
            log.warning("[run %s] no upload URL for %s: %s", run_id, name, e)
            note = "Not saved: the upload couldn't be authorised."
    await repo.upsert_asset(conn, run_id, name, **meta, bytes=size, storage="skipped", note=note)
    return {"ok": True, "skip": note}


async def register_uploaded(conn: Conn, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """`asset`: forward.py reports an uploaded file (or why it couldn't upload one)."""
    name = body.get("name")
    if not valid_name(name):
        return {"ok": False, "error": "invalid name"}
    assert isinstance(name, str)
    size = body.get("bytes")
    meta: dict[str, Any] = {
        "kind": clean_kind(body.get("assetKind")),
        "content_type": clean_content_type(body.get("contentType")),
        "bytes": size if isinstance(size, int) and size >= 0 else 0,
    }
    if await repo.get_asset(conn, run_id, name) is None and await repo.count_assets(conn, run_id) >= MAX_ASSETS_PER_RUN:
        return {"ok": False, "error": "too many files"}
    pathname = blob_pathname(run_id, name)
    if body.get("status") == "uploaded" and blob.configured():
        if body.get("pathname") not in (None, pathname):
            return {"ok": False, "error": "pathname mismatch"}
        url = body.get("url")
        if not (isinstance(url, str) and blob.valid_blob_url(url) and url.split("?")[0].endswith("/" + pathname)):
            url = blob.blob_url_for(pathname)
        await repo.upsert_asset(conn, run_id, name, **meta, storage="blob", blob_url=url, blob_pathname=pathname)
        return {"ok": True}
    note = body.get("note")
    note = settings.redact(note)[:300] if isinstance(note, str) and note else "Not saved."
    await repo.upsert_asset(conn, run_id, name, **meta, storage="skipped", note=note)
    return {"ok": True}


async def download_url(row: dict[str, Any]) -> str:
    """A presigned GET URL for a blob asset, valid for DOWNLOAD_URL_TTL_S. Raises blob.BlobError."""
    pathname = row["blob_pathname"]
    signed = await blob.issue_signed_token(pathname, ["get"], ttl_s=DOWNLOAD_URL_TTL_S)
    # `download=1` asks the CDN for Content-Disposition: attachment. Documented for public blob URLs; whether a private
    # presigned GET accepts the extra parameter is unverified, so it is opt-in (AUTOTINKER_BLOB_DOWNLOAD_PARAM=1).
    download = settings.env("AUTOTINKER_BLOB_DOWNLOAD_PARAM") == "1"
    return blob.presigned_get_url(signed, pathname, row.get("blob_url"), download=download)


async def read_blob(row: dict[str, Any]) -> bytes:
    """A blob asset's bytes, fetched through a fresh presigned GET URL (for the zip of all files). Raises
    blob.BlobError."""
    url = await download_url(row)
    async with blob._client() as client:
        resp = await client.get(url, follow_redirects=True)
    if resp.status_code != 200:
        raise blob.BlobError(f"download failed: HTTP {resp.status_code}")
    return resp.content


def zip_folder(run_id: str) -> str:
    """The folder the zip of all files unpacks into (predict.py runs from there)."""
    return f"autotinker-{run_id}"


INLINE_KINDS = frozenset({"code", "script", "text", "json"})
INLINE_MAX_BYTES = 1024 * 1024


def inline_ok(row: dict[str, Any]) -> bool:
    """Small text assets (the solution, predict.py, requirements.txt, model_card.json) can be read same-origin."""
    return row["kind"] in INLINE_KINDS and 0 <= int(row["bytes"] or 0) <= INLINE_MAX_BYTES


def inline_media_type(row: dict[str, Any]) -> str:
    """Never the engine-reported type as-is (a text/html asset must not render on our origin)."""
    return "application/json" if row["kind"] == "json" else "text/plain; charset=utf-8"
