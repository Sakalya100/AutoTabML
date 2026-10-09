"""Server-side preview of a public CSV link: rewrite share links, guard against SSRF, follow ≤ 3 redirects (each one
re-checked), read at most ~2 MB within 15 s, sniff that it's CSV/TSV, then parse the header + a sample.

The SSRF guard and share-link rewrites are the engine's own (urlguard.py, a verified copy of
src/autotinker/data/urlguard.py); the engine downloads the full file itself later, with the same guards.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import httpx

from autotinker_api import urlguard
from autotinker_api.preview.csvparse import looks_like_html, parse_table, sniff_decimal
from autotinker_api.preview.llm import llm_suggest
from autotinker_api.preview.suggest import Suggestion, metric_fits, suggest, suggestion_for

PREVIEW_MAX_BYTES = 2 * 1024 * 1024
ENGINE_MAX_BYTES = 50 * 1024 * 1024  # DEFAULT_MAX_BYTES in the engine's fetch.py
_REDIRECTS = {301, 302, 303, 307, 308}
USER_AGENT = "autotinker-preview/0.1 (+https://github.com/Sakalya100/AutoTabML)"

Resolver = urlguard.Resolver


class PreviewError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def guard_message(e: urlguard.UrlRejected) -> str:
    """The engine's guard messages, worded for the person pasting the link."""
    host = e.host
    return {
        "invalid_url": "That isn't a valid link. Paste the full address, starting with https://",
        "not_https": "Only https:// links are supported. Try the same link with https://",
        "credentials": "Links with a user name or password in them aren't allowed.",
        "dns": f'Couldn\'t find the server "{host}". Check the link for typos.',
        "blocked_host": f'"{host}" points at a private or reserved network address. '
        "Only public internet hosts are allowed.",
    }.get(e.code, str(e))


async def check_url(url: str, resolver: Resolver | None = None) -> None:
    """urlguard.check_url (DNS runs in a thread), raising PreviewError with a user-facing message."""
    try:
        await asyncio.to_thread(urlguard.check_url, url, resolver)
    except urlguard.UrlRejected as e:
        raise PreviewError(e.code, guard_message(e)) from None


@dataclass
class FetchedHead:
    text: str
    final_url: str
    content_type: str | None
    content_length: int | None
    bytes_read: int
    truncated: bool
    encoding: str = "utf-8"


def _decode(data: bytes, truncated: bool = False) -> tuple[str, str]:
    """(text, encoding) by the engine's rule (src/autotinker/data/csvformat.py detect_encoding): a BOM is utf-8-sig,
    valid UTF-8 is utf-8, else cp1252, else latin-1. A read cut short may split a UTF-8 character at the very end."""
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8", errors="replace"), "utf-8-sig"
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError as e:
        if truncated and e.start >= len(data) - 3:
            return data[: e.start].decode("utf-8", errors="replace"), "utf-8"
    try:
        return data.decode("cp1252"), "cp1252"
    except UnicodeDecodeError:
        return data.decode("latin-1"), "latin-1"


async def fetch_head(
    url: str,
    *,
    resolver: Resolver | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    timeout_s: float = 15.0,
    max_bytes: int = PREVIEW_MAX_BYTES,
    max_redirects: int = 3,
) -> FetchedHead:
    """GET with manual, re-checked redirects; reads at most `max_bytes` of the body."""
    headers = {"User-Agent": USER_AGENT, "Accept": "text/csv, text/tab-separated-values, text/plain, */*;q=0.1"}
    current, redirects = url, 0
    try:
        async with (
            asyncio.timeout(timeout_s),
            httpx.AsyncClient(
                transport=transport, follow_redirects=False, headers=headers, timeout=timeout_s
            ) as client,
        ):
            while True:
                await check_url(current, resolver)
                try:
                    async with client.stream("GET", current) as res:
                        if res.status_code in _REDIRECTS:
                            location = res.headers.get("location")
                            if not location:
                                raise PreviewError(
                                    "http_error", f"The server sent a redirect ({res.status_code}) with no target."
                                )
                            redirects += 1
                            if redirects > max_redirects:
                                raise PreviewError(
                                    "too_many_redirects", f"The link redirects more than {max_redirects} times."
                                )
                            current = urljoin(current, location)
                            continue
                        _raise_for_status(res.status_code)
                        encoded = res.headers.get("content-encoding", "identity") not in ("", "identity")
                        declared = res.headers.get("content-length", "")
                        content_length = (
                            int(declared) if declared.isdigit() and int(declared) > 0 and not encoded else None
                        )
                        if content_length and content_length > ENGINE_MAX_BYTES:
                            raise PreviewError(
                                "too_big",
                                f"The file is {content_length / 1048576:.0f} MB; "
                                f"the limit is {ENGINE_MAX_BYTES // 1048576} MB.",
                            )
                        buf = bytearray()
                        truncated = False
                        async for chunk in res.aiter_bytes():
                            buf.extend(chunk)
                            if len(buf) >= max_bytes:
                                truncated = True
                                break
                        data = bytes(buf[:max_bytes])
                        text, encoding = _decode(data, truncated)
                        return FetchedHead(
                            text=text,
                            encoding=encoding,
                            final_url=current,
                            content_type=res.headers.get("content-type"),
                            content_length=content_length,
                            bytes_read=len(data),
                            truncated=truncated,
                        )
                except httpx.TimeoutException:
                    raise PreviewError("timeout", f"The server took longer than {timeout_s:.0f} s to answer.") from None
                except httpx.HTTPError as e:
                    raise PreviewError("network", f"Couldn't download the link ({type(e).__name__}).") from None
    except TimeoutError:
        raise PreviewError("timeout", f"The download took longer than {timeout_s:.0f} s.") from None


def _raise_for_status(status: int) -> None:
    if status in (404, 410):
        raise PreviewError("not_found", "Nothing is at that link (404). Check that it's public and spelled right.")
    if status in (401, 403):
        raise PreviewError(
            "http_error",
            f"The server refused access ({status}). The file must be public — anyone with the link can view.",
        )
    if status >= 400:
        raise PreviewError("http_error", f"The server answered with an error (HTTP {status}).")


def sniff_content(head: FetchedHead) -> None:
    """Reject things that aren't delimited text."""
    t = head.text
    if not t.strip():
        raise PreviewError("empty", "The link returned an empty file.")
    if t.startswith("PAR1"):
        raise PreviewError(
            "not_csv", "That's a Parquet file. The preview reads CSV/TSV only for now — link to a CSV export instead."
        )
    if t.startswith("PK\x03\x04"):
        raise PreviewError("not_csv", "That's a ZIP archive. Link to the CSV file inside it instead.")
    if len(t) >= 2 and ord(t[0]) == 0x1F and ord(t[1]) == 0x8B:
        raise PreviewError("not_csv", "That's a gzip archive. Link to an uncompressed CSV instead.")
    if looks_like_html(t, head.content_type):
        raise PreviewError(
            "html",
            "That link opens a web page, not a data file. Use the direct download link (on GitHub, the “Raw” "
            "button; on Google Drive, make the file public).",
        )
    if "\x00" in t[:8192]:
        raise PreviewError("not_csv", "That's a binary file, not a CSV or TSV.")


async def build_preview(url: str, **deps: Any) -> dict[str, Any]:
    """Fetch + parse. Raises PreviewError with a user-facing message."""
    pasted = url.strip()
    resolved = urlguard.rewrite_share_link(pasted)
    head = await fetch_head(resolved, **deps)
    sniff_content(head)
    table = parse_table(head.text, partial=head.truncated, sample_rows=50)
    columns: list[str] = table["columns"]
    if len(columns) < 2:
        raise PreviewError("not_csv", "We couldn't find at least two columns. Is this a CSV or TSV with a header row?")
    seen: set[str] = set()
    for c in columns:
        if c in seen:
            raise PreviewError(
                "not_csv", f'Column "{c}" appears twice in the header; every column needs a unique name.'
            )
        seen.add(c)
    if table["parsedRows"] < 1:
        raise PreviewError("empty", "The file has a header but no data rows.")
    # Stats cover the first 5,000 rows; count the rest of what was read by line breaks.
    lines = head.text.count("\n") + (0 if head.text.endswith("\n") else 1)
    rows_read = max(table["parsedRows"], lines - 1)
    rows: int | None = rows_read
    if head.truncated:
        rows = round(head.content_length / head.bytes_read * rows_read) if head.content_length else None
    return {
        "url": pasted,
        "resolvedUrl": resolved,
        "finalUrl": head.final_url,
        "rewritten": resolved != pasted,
        "delimiter": table["delimiter"],
        # Handed to the engine with the run (csvFormat), so it parses the file exactly as this preview did.
        "encoding": head.encoding,
        "decimal": sniff_decimal(head.text, table["delimiter"]),
        "columns": columns,
        "stats": table["stats"],
        "sample": table["sample"],
        "rows": rows,
        "rowsExact": not head.truncated,
        "sizeBytes": head.content_length if head.content_length else (None if head.truncated else head.bytes_read),
    }


_TTL_S = 5 * 60
_MAX_ENTRIES = 40
_cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()


async def cached_preview(url: str, **deps: Any) -> dict[str, Any]:
    """Previews are cached briefly per instance, so retyping the goal doesn't refetch the file."""
    key = urlguard.rewrite_share_link(url.strip())
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < _TTL_S:
        return {**hit[1], "url": url.strip()}
    preview = await build_preview(url, **deps)
    _cache[key] = (time.monotonic(), preview)
    while len(_cache) > _MAX_ENTRIES:
        _cache.popitem(last=False)
    return preview


def peek_preview(url: str) -> dict[str, Any] | None:
    """The cached preview for `url` if this instance has a fresh one (never fetches)."""
    hit = _cache.get(urlguard.rewrite_share_link(url.strip()))
    return hit[1] if hit and time.monotonic() - hit[0] < _TTL_S else None


async def suggest_for(
    preview: dict[str, Any], goal: str, *, groq_key: str | None, gemini_key: str | None, **deps: Any
) -> tuple[Suggestion | None, str]:
    """Heuristics first; ask the LLM when the user typed a goal or the heuristics were unsure.
    Returns (suggestion, llm) with llm in used | skipped | unavailable."""
    stats = preview["stats"]
    heuristic = suggest(stats, goal)
    if not (goal.strip() or heuristic is None or heuristic["ambiguous"]):
        return heuristic, "skipped"
    if not groq_key and not gemini_key:
        return heuristic, "unavailable"
    out = await llm_suggest(stats, preview["sample"], goal, heuristic, groq_key=groq_key, gemini_key=gemini_key, **deps)
    if not out or not out.get("target"):
        return heuristic, "unavailable"
    why = "matches your sentence" if goal.strip() else "the likeliest column to predict"
    base = suggestion_for(stats, out["target"], why, False)
    metric = out.get("metric")
    return {
        **base,
        "metric": metric if isinstance(metric, str) and metric_fits(base["problemType"], metric) else base["metric"],
        "goalPlain": out.get("goalPlain") or base["goalPlain"],
        "why": out.get("why") or base["why"],
        "source": "llm",
        "ambiguous": False,
    }, "used"
