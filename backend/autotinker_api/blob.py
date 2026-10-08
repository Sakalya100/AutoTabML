"""Vercel Blob (private store) over its REST API: server uploads, and short-lived presigned URLs.

The Python `vercel` SDK (0.11.x) can put/get with the read-write token but has no signed URLs, so the three calls we
need are written out here (one httpx code path, easy to mock in tests):

    put_private(pathname, data)            PUT  {API}/?pathname=…           Authorization: Bearer <rw token>
    issue_signed_token(pathname, ops, …)   POST {API}/signed-token          → {delegationToken, clientSigningToken,
                                                                               validUntil}
    presigned_put / presigned_get_url      HMAC-SHA256 over a canonical string with clientSigningToken (no network)

Docs: https://vercel.com/docs/vercel-blob/private-storage (private blobs live at
https://<store>.private.blob.vercel-storage.com/<pathname> and need auth to read) and
https://vercel.com/docs/vercel-blob/vercel-signed-urls (issueSignedToken / presignUrl: a URL scoped to one operation and
one pathname, expiring within 7 days). The wire details (API base https://vercel.com/api/blob, `x-api-version: 12`,
the `/signed-token` body, the canonical string and the `vercel-blob-delegation` / `vercel-blob-signature` query
parameters) are not documented; they are ported from @vercel/blob 2.8.1's source (src/signed-token.ts, src/api.ts).

To keep that surface small, the delegation itself carries the expiry and the size cap and no per-URL options are
signed: the canonical string is just `operation=<op>\\npathname=<pathname>`.

Credentials: BLOB_READ_WRITE_TOKEN (vercel_blob_rw_<storeId>_<secret>) stays in this process. The sandbox only ever
receives a presigned PUT URL for one pathname.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx

from autotinker_api import settings

DEFAULT_API = "https://vercel.com/api/blob"
API_VERSION = "12"
TIMEOUT_S = 60.0

_transport: httpx.AsyncBaseTransport | None = None  # tests inject an httpx.MockTransport


class BlobError(RuntimeError):
    pass


def set_transport_for_tests(transport: httpx.AsyncBaseTransport | None) -> None:
    global _transport
    _transport = transport


def token() -> str | None:
    return settings.env("BLOB_READ_WRITE_TOKEN")


def configured() -> bool:
    return bool(token())


def api_url() -> str:
    return (settings.env("VERCEL_BLOB_API_URL") or DEFAULT_API).rstrip("/")


def api_host() -> str:
    return urlsplit(api_url()).hostname or "vercel.com"


def store_id(rw_token: str) -> str:
    """vercel_blob_rw_<storeId>_<secret> → storeId (the SDK's parseStoreIdFromReadWriteToken)."""
    parts = rw_token.split("_")
    return parts[3] if len(parts) > 3 else ""


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=TIMEOUT_S, transport=_transport)


def _base_headers(rw_token: str) -> dict[str, str]:
    return {"x-api-version": API_VERSION, "x-vercel-blob-store-id": store_id(rw_token)}


def _need_token() -> str:
    t = token()
    if not t:
        raise BlobError("BLOB_READ_WRITE_TOKEN is not set")
    return t


def _error(resp: httpx.Response, what: str) -> BlobError:
    code = ""
    try:
        body = resp.json()
        code = str((body.get("error") or {}).get("code") or "") if isinstance(body, dict) else ""
    except ValueError:
        pass
    return BlobError(f"{what} failed: HTTP {resp.status_code}{f' ({code})' if code else ''}")


async def put_private(pathname: str, data: bytes, content_type: str) -> dict[str, Any]:
    """Server upload with the read-write token. Returns the API's JSON ({url, pathname, contentType, ...})."""
    rw = _need_token()
    headers = {
        **_base_headers(rw),
        "authorization": f"Bearer {rw}",
        "x-vercel-blob-access": "private",
        "x-content-type": content_type,
        "x-add-random-suffix": "0",
        "x-allow-overwrite": "1",
    }
    async with _client() as c:
        try:
            resp = await c.put(f"{api_url()}/?{urlencode({'pathname': pathname})}", content=data, headers=headers)
        except httpx.HTTPError as e:
            raise BlobError(f"upload failed ({type(e).__name__})") from None
    if resp.status_code >= 400:
        raise _error(resp, "upload")
    out = resp.json()
    if not isinstance(out, dict) or not out.get("url"):
        raise BlobError("upload failed: unexpected response")
    return out


async def issue_signed_token(
    pathname: str, operations: list[str], *, ttl_s: int, maximum_size_in_bytes: int | None = None
) -> dict[str, Any]:
    """A delegation scoped to one pathname and some operations, valid for `ttl_s` seconds."""
    rw = _need_token()
    body: dict[str, Any] = {
        "pathname": pathname,
        "operations": operations,
        "validUntil": int(time.time() * 1000) + ttl_s * 1000,
    }
    if maximum_size_in_bytes is not None:
        body["maximumSizeInBytes"] = int(maximum_size_in_bytes)
    headers = {**_base_headers(rw), "authorization": f"Bearer {rw}", "content-type": "application/json"}
    async with _client() as c:
        try:
            resp = await c.post(f"{api_url()}/signed-token", content=json.dumps(body), headers=headers)
        except httpx.HTTPError as e:
            raise BlobError(f"signed token failed ({type(e).__name__})") from None
    if resp.status_code >= 400:
        raise _error(resp, "signed token")
    out = resp.json()
    if not isinstance(out, dict) or not out.get("delegationToken") or not out.get("clientSigningToken"):
        raise BlobError("signed token failed: unexpected response")
    return out


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def canonical_string(operation: str, pathname: str) -> str:
    """The SDK's canonicalString with no optional presign entries: the lines sorted by their UTF-8 bytes."""
    lines = [f"operation={operation}", f"pathname={pathname}"]
    return "\n".join(sorted(lines, key=lambda s: s.encode()))


def signature(client_signing_token: str, operation: str, pathname: str) -> str:
    mac = hmac.new(client_signing_token.encode(), canonical_string(operation, pathname).encode(), hashlib.sha256)
    return _b64url(mac.digest())


def _signed_params(signed: dict[str, Any], operation: str, pathname: str) -> dict[str, str]:
    return {
        "vercel-blob-delegation": str(signed["delegationToken"]),
        "vercel-blob-signature": signature(str(signed["clientSigningToken"]), operation, pathname),
    }


def presigned_put(signed: dict[str, Any], pathname: str, content_type: str) -> dict[str, Any]:
    """What the sandbox needs to upload one file: {method, url, headers} (no credential beyond the URL itself)."""
    query = urlencode({"pathname": pathname, **_signed_params(signed, "put", pathname)})
    headers = {
        "x-api-version": API_VERSION,
        "x-vercel-blob-store-id": store_id(_need_token()),
        "x-vercel-blob-access": "private",
        "x-content-type": content_type,
    }
    return {"method": "PUT", "url": f"{api_url()}/?{query}", "headers": headers}


def blob_url_for(pathname: str) -> str:
    return f"https://{store_id(_need_token()).lower()}.private.blob.vercel-storage.com/{pathname}"


def presigned_get_url(signed: dict[str, Any], pathname: str, blob_url: str | None, *, download: bool) -> str:
    """The blob's URL plus the signature (and `download=1`, which asks the CDN for an attachment)."""
    base = blob_url or blob_url_for(pathname)
    params = _signed_params(signed, "get", pathname)
    if download:
        params = {"download": "1", **params}
    sep = "&" if urlsplit(base).query else "?"
    return f"{base}{sep}{urlencode(params)}"


def valid_blob_url(url: str) -> bool:
    parts = urlsplit(url)
    return parts.scheme == "https" and (parts.hostname or "").endswith(".blob.vercel-storage.com")
