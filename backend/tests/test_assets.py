"""A run's downloadable files: the local runner registering them from disk, the sandbox's presigned-upload flow through
the ingest route, owner-checked listing and download (local file, or a redirect to a presigned Blob URL), the size
cap, forward.py's helpers, and the presigned-URL signing against vectors produced by the official @vercel/blob SDK.
No network: Blob's API is an httpx.MockTransport."""

from __future__ import annotations

import http.server
import json
import os
import sys
import textwrap
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from conftest import FakeRunner, run_async
from fastapi.testclient import TestClient

from autotinker_api import assets, blob, db, repo
from autotinker_api.runners import base, forward
from autotinker_api.runners.local import LocalRunner

RW = "vercel_blob" + "_rw_StoreAbc123_secretsecret"  # a fake token, split so scanners don't flag it
CLIENT_SECRET = "client-signing-secret-xyz"
MB = 1024 * 1024


@pytest.fixture(autouse=True)
def public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    import autotinker_api.urlguard as guard

    monkeypatch.setattr(guard, "system_resolve", lambda host: ["93.184.216.34"])


@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "data"
    monkeypatch.setenv("AUTOTINKER_DATA_DIR", str(d))
    return d


class FakeBlob:
    """Blob's REST API: /signed-token issues delegations, PUT /?pathname= stores bytes."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.fail_signing = False
        self.fail_put = False
        self.stored: dict[str, bytes] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path.endswith("/signed-token"):
            if self.fail_signing:
                return httpx.Response(500, json={"error": {"code": "internal_server_error"}})
            body = json.loads(request.content)
            payload = {"storeId": "store_StoreAbc123", **body}
            seg = json.dumps(payload).encode().hex()
            return httpx.Response(
                200,
                json={
                    "delegationToken": f"{seg}.sig",
                    "clientSigningToken": CLIENT_SECRET,
                    "validUntil": body["validUntil"],
                },
            )
        if request.method == "PUT":
            if self.fail_put:
                return httpx.Response(503, json={"error": {"code": "service_unavailable"}})
            pathname = request.url.params["pathname"]
            self.stored[pathname] = request.content
            url = f"https://storeabc123.private.blob.vercel-storage.com/{pathname}"
            return httpx.Response(200, json={"url": url, "downloadUrl": url + "?download=1", "pathname": pathname})
        if request.method == "GET" and "vercel-blob-signature" in request.url.params:  # a presigned download
            data = self.stored.get(request.url.path.lstrip("/"))
            return httpx.Response(200, content=data) if data is not None else httpx.Response(404)
        return httpx.Response(404)

    def signing_bodies(self) -> list[dict[str, Any]]:
        return [json.loads(r.content) for r in self.requests if r.url.path.endswith("/signed-token")]


@pytest.fixture()
def fake_blob(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeBlob]:
    fake = FakeBlob()
    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", RW)
    blob.set_transport_for_tests(httpx.MockTransport(fake))
    yield fake
    blob.set_transport_for_tests(None)


def start(client: TestClient) -> str:
    body = {"url": "https://data.example/BreastCancer.csv", "target": "Class", "maxExperiments": 3}
    r = client.post("/api/runs", json=body)
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


def token_for(fake: FakeRunner, run_id: str) -> dict[str, str]:
    return {"X-Ingest-Token": next(r.ingest_token for r in fake.started if r.run["id"] == run_id)}


def engine_files(out_dir: Path, engine_rid: str = "20261009-120000-d-abc123") -> dict[str, Any]:
    """An engine run dir with assets/ and the matching assets_ready event."""
    a = out_dir / engine_rid / "assets"
    a.mkdir(parents=True)
    (a / "model.joblib").write_bytes(b"\x80model")
    (a / "pipeline.py").write_text("print('hi')\n")
    (out_dir / engine_rid / "harness").mkdir()
    (out_dir / engine_rid / "harness" / "test.pkl").write_bytes(b"locked test data")
    return {
        "type": "assets_ready",
        "run_id": engine_rid,
        "seq": 40,
        "charts": [],
        "files": [
            {"name": "model.joblib", "path": "assets/model.joblib", "bytes": 6, "kind": "model",
             "content_type": "application/octet-stream"},
            {"name": "pipeline.py", "path": "assets/pipeline.py", "bytes": 12, "kind": "code",
             "content_type": "text/x-python"},
            {"name": "gone.bin", "path": "assets/gone.bin", "bytes": 1, "kind": "model"},
            {"name": "test.pkl", "path": "assets/../harness/test.pkl", "bytes": 16, "kind": "data"},
            {"name": "../evil", "path": "assets/model.joblib", "bytes": 6, "kind": "model"},
        ],
    }  # fmt: skip


async def _register(run_id: str, event: dict[str, Any], out_dir: Path, data_dir: Path) -> list[dict[str, Any]]:
    async with db.connection() as conn:
        return await assets.register_local(conn, run_id, event, out_dir, data_dir)


async def _rows(run_id: str) -> dict[str, dict[str, Any]]:
    async with db.connection() as conn:
        return {r["name"]: r for r in await repo.list_assets(conn, run_id)}


# ------------------------------------------------------------------------------------------------ local runner


FAKE_ENGINE = textwrap.dedent(
    """
    import json, os, sys
    args = sys.argv[1:]
    out = args[args.index("--out") + 1]
    rid = "20261009-120000-d-abc123"
    os.makedirs(os.path.join(out, rid, "assets"))
    open(os.path.join(out, rid, "assets", "model.joblib"), "wb").write(b"m" * 10)
    open(os.path.join(out, rid, "assets", "big.bin"), "wb").write(b"b" * (2 * 1024 * 1024))
    json.dump({"ok": True}, open(os.path.join(out, rid, "run.json"), "w"))
    files = [{"name": "model.joblib", "path": "assets/model.joblib", "bytes": 10, "kind": "model",
              "content_type": "application/octet-stream"},
             {"name": "big.bin", "path": "assets/big.bin", "bytes": 2097152, "kind": "model"}]
    print(json.dumps({"seq": 0, "type": "assets_ready", "run_id": rid, "ts": "2026-10-09T10:00:00Z",
                      "charts": [], "files": files}), flush=True)
    """
)


def test_local_runner_registers_files_from_disk(
    dburl: str, data_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = tmp_path / "engine.py"
    script.write_text(FAKE_ENGINE)
    monkeypatch.setenv("AUTOTINKER_PYTHON_CMD", f"{sys.executable} {script}")
    monkeypatch.setenv("AUTOTINKER_MAX_ASSET_MB", "1")

    async def go() -> None:
        async with db.connection() as conn:
            await repo.create_session(conn, session_id="s-test00000000", owner_id="o-test0000000000000000", title="t")
            await repo.insert_run(
                conn,
                {
                    "id": "r-assets0001", "session_id": "s-test00000000", "target": "y", "metric": None, "goal": "",
                    "max_experiments": 2, "runner": "local", "deadline_at": None, "source": "url",
                    "source_url": "https://data.example/d.csv", "file_name": "d.csv", "file_bytes": 0,
                },
            )  # fmt: skip
            run = await repo.get_run(conn, "r-assets0001")
            assert run is not None
            await LocalRunner().start(base.StartRequest(run=run, csv=None, ingest_url="", ingest_token=""))
            for _ in range(300):
                row = await repo.get_run(conn, "r-assets0001")
                if row and repo.is_terminal(row["status"]):
                    break
                await __import__("asyncio").sleep(0.05)
            assert row and row["status"] == "finished", row
        rows = await _rows("r-assets0001")
        assert rows["model.joblib"]["storage"] == "local" and rows["model.joblib"]["bytes"] == 10
        rel = "runs/r-assets0001/out/20261009-120000-d-abc123/assets/model.joblib"
        assert rows["model.joblib"]["local_path"] == rel
        assert rows["big.bin"]["storage"] == "skipped" and "over the 1 MB limit" in rows["big.bin"]["note"]

    run_async(go())


def test_register_local_validates_paths_and_names(dburl: str, data_dir: Path, fake_runner: FakeRunner) -> None:
    out = data_dir / "runs" / "r-abcdef1234" / "out"
    event = engine_files(out)

    async def go() -> None:
        async with db.connection() as conn:
            await repo.create_session(conn, session_id="s-test00000000", owner_id="o-test0000000000000000", title="t")
            await repo.insert_run(
                conn,
                {
                    "id": "r-abcdef1234", "session_id": "s-test00000000", "target": "y", "metric": None, "goal": "",
                    "max_experiments": 2, "runner": "local", "deadline_at": None, "source": "url",
                    "source_url": "https://data.example/d.csv", "file_name": "d.csv", "file_bytes": 0,
                },
            )  # fmt: skip
        await _register("r-abcdef1234", event, out, data_dir)
        rows = await _rows("r-abcdef1234")
        assert set(rows) == {"model.joblib", "pipeline.py", "gone.bin", "test.pkl"}  # "../evil" is dropped
        assert rows["pipeline.py"]["storage"] == "local" and rows["pipeline.py"]["kind"] == "code"
        assert rows["pipeline.py"]["content_type"] == "text/x-python"
        assert rows["gone.bin"]["storage"] == "skipped"
        assert rows["test.pkl"]["storage"] == "skipped"  # outside assets/: the locked test data is never served
        # registering again (a retry) replaces, never duplicates
        await _register("r-abcdef1234", event, out, data_dir)
        assert len(await _rows("r-abcdef1234")) == 4

    run_async(go())


def test_register_local_uploads_to_blob_when_configured(dburl: str, data_dir: Path, fake_blob: FakeBlob) -> None:
    out = data_dir / "runs" / "r-abcdef1234" / "out"
    event = engine_files(out)
    event["files"] = event["files"][:2]

    async def go() -> None:
        async with db.connection() as conn:
            await repo.create_session(conn, session_id="s-test00000000", owner_id="o-test0000000000000000", title="t")
            await repo.insert_run(
                conn,
                {
                    "id": "r-abcdef1234", "session_id": "s-test00000000", "target": "y", "metric": None, "goal": "",
                    "max_experiments": 2, "runner": "local", "deadline_at": None, "source": "url",
                    "source_url": "https://data.example/d.csv", "file_name": "d.csv", "file_bytes": 0,
                },
            )  # fmt: skip
        fake_blob.fail_put = False
        await _register("r-abcdef1234", {**event, "files": event["files"][:1]}, out, data_dir)
        fake_blob.fail_put = True  # a failed upload keeps the file on disk instead
        await _register("r-abcdef1234", {**event, "files": event["files"][1:]}, out, data_dir)
        rows = await _rows("r-abcdef1234")
        model = rows["model.joblib"]
        assert model["storage"] == "blob" and model["blob_pathname"] == "runs/r-abcdef1234/model.joblib"
        assert model["blob_url"].startswith("https://storeabc123.private.blob.vercel-storage.com/")
        assert fake_blob.stored["runs/r-abcdef1234/model.joblib"] == b"\x80model"
        put = next(r for r in fake_blob.requests if r.method == "PUT")
        assert put.headers["authorization"] == f"Bearer {RW}"
        assert put.headers["x-vercel-blob-access"] == "private" and put.headers["x-api-version"] == "12"
        assert rows["pipeline.py"]["storage"] == "local"

    run_async(go())


# --------------------------------------------------------------------------------------------------------- API


def test_listing_download_and_owner_checks(client: TestClient, other: TestClient, data_dir: Path) -> None:
    run_id = start(client)
    assert client.get(f"/api/runs/{run_id}/assets").json() == {"files": []}
    out = data_dir / "runs" / run_id / "out"
    run_async(_register(run_id, engine_files(out), out, data_dir))

    files = client.get(f"/api/runs/{run_id}/assets").json()["files"]
    by = {f["name"]: f for f in files}
    assert by["model.joblib"] == {
        "name": "model.joblib",
        "kind": "model",
        "bytes": 6,
        "contentType": "application/octet-stream",
        "downloadUrl": f"/api/runs/{run_id}/assets/model.joblib",
        "available": True,
        "note": None,
    }
    assert by["gone.bin"]["available"] is False and by["gone.bin"]["note"]

    r = client.get(f"/api/runs/{run_id}/assets/pipeline.py")
    assert r.status_code == 200 and r.text == "print('hi')\n"
    disposition = r.headers["content-disposition"]
    assert disposition.startswith("attachment") and "pipeline.py" in disposition
    assert client.get(f"/api/runs/{run_id}/assets/gone.bin").status_code == 404
    assert client.get(f"/api/runs/{run_id}/assets/nope.bin").json() == {"error": "No such file."}
    assert client.get(f"/api/runs/{run_id}/assets/..%2Fx").status_code == 404

    # someone else's run looks exactly like a missing one
    assert other.get(f"/api/runs/{run_id}/assets").json() == {"error": "No such run."}
    assert other.get(f"/api/runs/{run_id}/assets/pipeline.py").status_code == 404
    assert client.get("/api/runs/r-nope000000/assets").status_code == 404

    (out / "20261009-120000-d-abc123" / "assets" / "pipeline.py").unlink()  # data dir cleaned up
    assert client.get(f"/api/runs/{run_id}/assets/pipeline.py").status_code == 404
    assert {f["name"]: f for f in client.get(f"/api/runs/{run_id}/assets").json()["files"]}["pipeline.py"][
        "available"
    ] is False


def test_zip_of_all_files(client: TestClient, other: TestClient, data_dir: Path) -> None:
    import io
    import zipfile

    run_id = start(client)
    assert client.get(f"/api/runs/{run_id}/assets.zip").status_code == 404  # nothing yet
    out = data_dir / "runs" / run_id / "out"
    run_async(_register(run_id, engine_files(out), out, data_dir))
    r = client.get(f"/api/runs/{run_id}/assets.zip")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"] == f'attachment; filename="autotinker-{run_id}.zip"'
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    folder = f"autotinker-{run_id}"
    assert sorted(zf.namelist()) == [f"{folder}/model.joblib", f"{folder}/pipeline.py"]  # skipped files left out
    assert zf.read(f"{folder}/pipeline.py") == b"print('hi')\n"
    assert other.get(f"/api/runs/{run_id}/assets.zip").json() == {"error": "No such run."}


def test_inline_read_of_small_text_assets(client: TestClient, other: TestClient, data_dir: Path) -> None:
    run_id = start(client)
    out = data_dir / "runs" / run_id / "out"
    ev = engine_files(out)
    a = out / ev["run_id"] / "assets"
    (a / "model_card.json").write_text('{"target": "Class"}')
    (a / "page.html").write_text("<script>alert(1)</script>")
    ev["files"] += [
        {"name": "model_card.json", "path": "assets/model_card.json", "kind": "json",
         "content_type": "application/json"},
        {"name": "page.html", "path": "assets/page.html", "kind": "code", "content_type": "text/html"},
    ]  # fmt: skip
    run_async(_register(run_id, ev, out, data_dir))

    r = client.get(f"/api/runs/{run_id}/assets/pipeline.py?inline=1")
    assert r.status_code == 200 and r.text == "print('hi')\n"
    assert r.headers["content-type"] == "text/plain; charset=utf-8"
    assert r.headers["cache-control"] == "private, no-store" and r.headers["x-content-type-options"] == "nosniff"
    assert "attachment" not in r.headers.get("content-disposition", "")
    card = client.get(f"/api/runs/{run_id}/assets/model_card.json?inline=1")
    assert card.headers["content-type"] == "application/json" and card.json() == {"target": "Class"}
    html = client.get(f"/api/runs/{run_id}/assets/page.html?inline=1")
    assert html.headers["content-type"] == "text/plain; charset=utf-8"  # never rendered as HTML on our origin
    assert client.get(f"/api/runs/{run_id}/assets/model.joblib?inline=1").status_code == 415  # not a text kind
    assert other.get(f"/api/runs/{run_id}/assets/pipeline.py?inline=1").status_code == 404  # owner-checked
    assert client.get(f"/api/runs/{run_id}/assets/gone.bin?inline=1").status_code == 404


def test_inline_read_of_blob_assets(
    client: TestClient, fake_runner: FakeRunner, fake_blob: FakeBlob, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = start(client)
    auth = token_for(fake_runner, run_id)
    ingest = f"/api/runs/{run_id}/ingest"

    def register(name: str, kind: str, size: int) -> None:
        body = {"kind": "asset", "name": name, "assetKind": kind, "contentType": "text/plain", "status": "uploaded",
                "bytes": size, "pathname": f"runs/{run_id}/{name}"}  # fmt: skip
        assert client.post(ingest, json=body, headers=auth).json() == {"ok": True}

    fake_blob.stored[f"runs/{run_id}/requirements.txt"] = b"scikit-learn==1.9.1\n"
    register("requirements.txt", "text", 20)
    r = client.get(f"/api/runs/{run_id}/assets/requirements.txt?inline=1")
    assert r.status_code == 200 and r.text == "scikit-learn==1.9.1\n"  # read server-side: no redirect
    plain = client.get(f"/api/runs/{run_id}/assets/requirements.txt", follow_redirects=False)
    assert plain.status_code == 302  # downloads stay redirects

    register("big.py", "code", 2 * MB)
    assert client.get(f"/api/runs/{run_id}/assets/big.py?inline=1").status_code == 415
    fake_blob.stored.clear()
    assert client.get(f"/api/runs/{run_id}/assets/requirements.txt?inline=1").status_code == 503


def test_zip_reads_blob_files(client: TestClient, fake_runner: FakeRunner, fake_blob: FakeBlob) -> None:
    import io
    import zipfile

    run_id = start(client)
    auth = token_for(fake_runner, run_id)
    pathname = f"runs/{run_id}/predict.py"
    fake_blob.stored[pathname] = b"print('predict')\n"
    client.post(
        f"/api/runs/{run_id}/ingest",
        json={"kind": "asset", "name": "predict.py", "assetKind": "script", "contentType": "text/x-python",
              "status": "uploaded", "bytes": 17, "pathname": pathname},
        headers=auth,
    )  # fmt: skip
    r = client.get(f"/api/runs/{run_id}/assets.zip")
    assert r.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert zf.read(f"autotinker-{run_id}/predict.py") == b"print('predict')\n"
    fake_blob.stored.clear()
    assert client.get(f"/api/runs/{run_id}/assets.zip").status_code == 503  # nothing readable


def test_sandbox_upload_flow_and_blob_download(
    client: TestClient, fake_runner: FakeRunner, fake_blob: FakeBlob, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = start(client)
    auth = token_for(fake_runner, run_id)
    ingest = f"/api/runs/{run_id}/ingest"
    pathname = f"runs/{run_id}/model.joblib"
    meta = {"name": "model.joblib", "assetKind": "model", "contentType": "application/octet-stream"}

    # no token → no upload URL
    assert client.post(ingest, json={"kind": "asset_upload_url", **meta, "bytes": 5}).status_code == 401

    r = client.post(ingest, json={"kind": "asset_upload_url", **meta, "bytes": 5}, headers=auth).json()
    assert r["pathname"] == pathname
    up = r["upload"]
    assert up["method"] == "PUT" and up["headers"]["x-vercel-blob-access"] == "private"
    assert up["headers"]["x-vercel-blob-store-id"] == "StoreAbc123" and "authorization" not in up["headers"]
    parts = urlsplit(up["url"])
    assert parts.netloc == "vercel.com" and parts.path == "/api/blob/"
    q = parse_qs(parts.query)
    assert q["pathname"] == [pathname]
    assert q["vercel-blob-signature"] == [blob.signature(CLIENT_SECRET, "put", pathname)]
    assert RW not in json.dumps(r)  # the read-write token never leaves the API
    signed = fake_blob.signing_bodies()[-1]
    assert signed["pathname"] == pathname and signed["operations"] == ["put"]
    assert signed["maximumSizeInBytes"] == 100 * MB
    token_req = next(x for x in fake_blob.requests if x.url.path.endswith("/signed-token"))
    assert token_req.headers["authorization"] == f"Bearer {RW}" and token_req.url.host == "vercel.com"

    # forward.py reports the upload; a wrong pathname is refused
    assert client.post(
        ingest, json={"kind": "asset", **meta, "status": "uploaded", "bytes": 5, "pathname": "runs/x/y"}, headers=auth
    ).json() == {"ok": False, "error": "pathname mismatch"}
    blob_url = f"https://storeabc123.private.blob.vercel-storage.com/{pathname}"
    ok = client.post(
        ingest,
        json={"kind": "asset", **meta, "status": "uploaded", "bytes": 5, "pathname": pathname, "url": blob_url},
        headers=auth,
    )
    assert ok.json() == {"ok": True}
    listed = client.get(f"/api/runs/{run_id}/assets").json()["files"]
    assert listed[0]["name"] == "model.joblib" and listed[0]["available"] is True and listed[0]["bytes"] == 5

    d = client.get(f"/api/runs/{run_id}/assets/model.joblib", follow_redirects=False)
    assert d.status_code == 302 and d.headers["cache-control"] == "no-store"
    loc = urlsplit(d.headers["location"])
    assert f"https://{loc.netloc}{loc.path}" == blob_url
    lq = parse_qs(loc.query)
    assert "download" not in lq and lq["vercel-blob-signature"] == [blob.signature(CLIENT_SECRET, "get", pathname)]
    monkeypatch.setenv("AUTOTINKER_BLOB_DOWNLOAD_PARAM", "1")
    d1 = client.get(f"/api/runs/{run_id}/assets/model.joblib", follow_redirects=False)
    assert parse_qs(urlsplit(d1.headers["location"]).query)["download"] == ["1"]
    get_signed = fake_blob.signing_bodies()[-1]
    assert get_signed["operations"] == ["get"] and get_signed["pathname"] == pathname
    assert "maximumSizeInBytes" not in get_signed

    fake_blob.fail_signing = True
    failed = client.get(f"/api/runs/{run_id}/assets/model.joblib", follow_redirects=False)
    assert failed.status_code == 503 and "download link" in failed.json()["error"]

    # forward.py reporting a failed upload
    client.post(
        ingest,
        json={
            "kind": "asset",
            "name": "pipeline.py",
            "status": "skipped",
            "bytes": 9,
            "note": "Upload failed (HTTP 403).",
        },  # noqa: E501
        headers=auth,
    )
    by = {f["name"]: f for f in client.get(f"/api/runs/{run_id}/assets").json()["files"]}
    assert by["pipeline.py"]["available"] is False and by["pipeline.py"]["note"] == "Upload failed (HTTP 403)."
    assert client.get(f"/api/runs/{run_id}/assets/pipeline.py").json() == {"error": "Upload failed (HTTP 403)."}


def test_upload_url_size_cap_and_unconfigured_storage(
    client: TestClient, fake_runner: FakeRunner, fake_blob: FakeBlob, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = start(client)
    auth = token_for(fake_runner, run_id)
    ingest = f"/api/runs/{run_id}/ingest"
    big = {"kind": "asset_upload_url", "name": "huge.bin", "assetKind": "model", "bytes": 100 * MB + 1}
    r = client.post(ingest, json=big, headers=auth).json()
    assert "upload" not in r and "over the 100 MB limit" in r["skip"]
    assert fake_blob.signing_bodies() == []  # no grant for a file over the cap
    bad = client.post(ingest, json={**big, "name": "../x", "bytes": 1}, headers=auth).json()
    assert bad["ok"] is False

    monkeypatch.delenv("BLOB_READ_WRITE_TOKEN")
    r2 = client.post(ingest, json={**big, "name": "m.joblib", "bytes": 10}, headers=auth).json()
    assert r2["skip"] == assets.NOT_CONFIGURED_NOTE
    by = {f["name"]: f for f in client.get(f"/api/runs/{run_id}/assets").json()["files"]}
    assert by["huge.bin"]["available"] is False and by["huge.bin"]["bytes"] == 100 * MB + 1
    assert by["m.joblib"]["note"] == assets.NOT_CONFIGURED_NOTE


# ------------------------------------------------------------------------------------------------------ signing


def test_presigned_urls_match_the_official_sdk(monkeypatch: pytest.MonkeyPatch) -> None:
    """Vectors from @vercel/blob 2.8.1's presignUrl() (node, offline) with this delegation and signing secret."""
    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", RW)
    deleg = (
        "eyJzdG9yZUlkIjoic3RvcmVfU3RvcmVBYmMxMjMiLCJwYXRobmFtZSI6InJ1bnMvci1hYmNkZWYxMjM0L21vZGVsLmpvYmxpYiIsIm9wZXJh"
        "dGlvbnMiOlsicHV0IiwiZ2V0Il0sInZhbGlkVW50aWwiOjQxMDI0NDQ4MDAwMDAsIm1heGltdW1TaXplSW5CeXRlcyI6MTA0ODU3NjAwfQ"
        ".fakesig"
    )
    signed = {"delegationToken": deleg, "clientSigningToken": CLIENT_SECRET}
    p = "runs/r-abcdef1234/model.joblib"
    assert blob.presigned_put(signed, p, "application/octet-stream")["url"] == (
        "https://vercel.com/api/blob/?pathname=runs%2Fr-abcdef1234%2Fmodel.joblib"
        f"&vercel-blob-delegation={deleg}&vercel-blob-signature=2fpYeXehcR4TM59Eu87VmTxh4eh4XDPDF0mbOi8xSc4"
    )
    assert blob.presigned_get_url(signed, p, None, download=False) == (
        "https://storeabc123.private.blob.vercel-storage.com/runs/r-abcdef1234/model.joblib"
        f"?vercel-blob-delegation={deleg}&vercel-blob-signature=06rXpUFlnerWNg6a8DnxrjvucxYNl3uW3bsRCzL0VGg"
    )
    assert blob.store_id(RW) == "StoreAbc123"
    assert blob.canonical_string("put", p) == f"operation=put\npathname={p}"


def test_blob_token_is_a_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    from autotinker_api import settings

    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", RW)
    assert RW in settings.known_secrets()
    assert "secretsecret" not in settings.redact(f"token {'vercel_blob'}_rw_Other123_abcdefghijk leaked")
    assert settings.engine_env().get("BLOB_READ_WRITE_TOKEN") == ""  # blanked so the engine's .env loader can't load it


def test_sandbox_policy_allows_blob_host_only_with_a_store() -> None:
    from autotinker_api.runners import sandbox

    def dumped(env: dict[str, str]) -> str:
        policy = sandbox.run_policy(None, "app.example", env)
        has_dump = hasattr(policy, "model_dump")
        return json.dumps(policy.model_dump(mode="json", by_alias=True)) if has_dump else str(policy)

    assert "vercel.com" not in dumped({})
    with_store = dumped({"BLOB_READ_WRITE_TOKEN": RW})
    assert "vercel.com" in with_store and RW not in with_store and "secretsecret" not in with_store
    assert "--out /vercel/work/out" in sandbox.RUN_SH
    assert Path(forward.__file__).read_text() == sandbox.FORWARD_PY


# ---------------------------------------------------------------------------------------------------- forward.py


def test_forward_resolves_only_files_inside_assets(tmp_path: Path) -> None:
    out = tmp_path / "out"
    engine_files(out, "rid1")
    (tmp_path / "secret.txt").write_text("x")
    os.symlink(tmp_path / "secret.txt", out / "rid1" / "assets" / "link.txt")
    ok = forward.resolve_asset_path(str(out), "rid1", "assets/model.joblib")
    assert ok and ok.endswith("assets/model.joblib")
    assert forward.resolve_asset_path(str(out), "other-rid", "assets/model.joblib") == ok  # falls back to out/*/
    for bad in ("assets/../harness/test.pkl", "/etc/passwd", "assets/link.txt", "harness/test.pkl", "", None, "assets"):
        assert forward.resolve_asset_path(str(out), "rid1", bad) is None, bad
    assert forward.resolve_asset_path(str(out), "../..", "assets/model.joblib") == ok  # odd ids are ignored
    assert forward.assets_event('{"type": "assets_ready", "files": []}') == {"type": "assets_ready", "files": []}
    assert forward.assets_event('{"type": "run_finished", "note": "assets_ready"}') is None
    assert forward.assets_event("not json") is None


def test_forward_upload_assets_flow(tmp_path: Path) -> None:
    out = tmp_path / "out"
    event = engine_files(out, "rid1")
    event["files"].append({"name": "refused.bin", "path": "assets/model.joblib", "kind": "model"})
    event["files"].append({"name": "flaky.bin", "path": "assets/model.joblib", "kind": "model"})
    posted: list[dict[str, Any]] = []
    puts: list[tuple[str, dict[str, str], str, int]] = []

    def post_json(body: dict[str, Any]) -> dict[str, Any] | None:
        posted.append(body)
        if body["kind"] == "asset_upload_url":
            if body["name"] == "refused.bin":
                return {"ok": True, "skip": "too large"}
            return {
                "ok": True,
                "pathname": f"runs/r-x/{body['name']}",
                "upload": {
                    "method": "PUT",
                    "url": f"https://vercel.com/api/blob/?n={body['name']}",
                    "headers": {"h": "1"},
                },  # noqa: E501
            }
        return {"ok": True}

    def put_file(url: str, headers: dict[str, str], path: str, size: int) -> dict[str, Any]:
        puts.append((url, headers, path, size))
        if "flaky" in url:
            raise forward.UploadError("HTTP 403")
        return {"url": "https://s.private.blob.vercel-storage.com/" + url.split("=")[1]}

    outcomes = forward.upload_assets(event, str(out), post_json=post_json, put_file=put_file)
    assert outcomes == [
        "model.joblib: uploaded",
        "pipeline.py: uploaded",
        "gone.bin: missing",
        "test.pkl: missing",
        "../evil: uploaded",  # forward.py doesn't judge names; the API refuses it (see the ingest tests)
        "refused.bin: skipped (too large)",
        "flaky.bin: upload failed",
    ]
    assert puts[0][1] == {"h": "1"} and puts[0][3] == 6
    registered = {b["name"]: b for b in posted if b["kind"] == "asset"}
    assert registered["model.joblib"]["status"] == "uploaded"
    assert registered["model.joblib"]["pathname"] == "runs/r-x/model.joblib"
    assert registered["model.joblib"]["assetKind"] == "model" and registered["model.joblib"]["bytes"] == 6
    assert registered["gone.bin"]["status"] == "skipped"
    assert registered["flaky.bin"] == {
        "kind": "asset",
        "name": "flaky.bin",
        "assetKind": "model",
        "contentType": "",
        "status": "skipped",
        "bytes": 6,
        "note": "Upload failed (HTTP 403).",
    }
    assert "refused.bin" not in registered  # the API already recorded why


class _PutHandler(http.server.BaseHTTPRequestHandler):
    received: list[tuple[str, dict[str, str], bytes]] = []
    status = 200
    reply = b'{"url": "https://s.private.blob.vercel-storage.com/a", "pathname": "a"}'

    def do_PUT(self) -> None:  # noqa: N802
        n = int(self.headers["Content-Length"])
        _PutHandler.received.append((self.path, {k.lower(): v for k, v in self.headers.items()}, self.rfile.read(n)))
        self.send_response(_PutHandler.status)
        self.end_headers()
        self.wfile.write(_PutHandler.reply)

    def log_message(self, *args: Any) -> None:
        pass


def test_forward_put_file_streams_from_disk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(forward.time, "sleep", lambda s: None)
    srv = http.server.HTTPServer(("127.0.0.1", 0), _PutHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        f = tmp_path / "m.bin"
        f.write_bytes(b"x" * 70000)
        url = f"http://127.0.0.1:{srv.server_port}/api/blob/?pathname=a"
        out = forward.put_file(url, {"x-vercel-blob-access": "private"}, str(f), 70000)
        assert out["pathname"] == "a"
        path, headers, body = _PutHandler.received[-1]
        assert path == "/api/blob/?pathname=a" and body == b"x" * 70000
        assert headers["x-vercel-blob-access"] == "private"

        _PutHandler.status, _PutHandler.reply = 400, b'{"error": {"message": "This blob already exists"}}'
        assert forward.put_file(url, {}, str(f), 70000) == {}  # an earlier attempt got through

        _PutHandler.status, _PutHandler.reply = 403, b'{"error": {"code": "forbidden"}}'
        n = len(_PutHandler.received)
        with pytest.raises(forward.UploadError, match="HTTP 403"):
            forward.put_file(url, {}, str(f), 70000)
        assert len(_PutHandler.received) == n + 1  # a refusal isn't retried
    finally:
        srv.shutdown()
        _PutHandler.status = 200
