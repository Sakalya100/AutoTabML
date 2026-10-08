"""Download a tabular data file from a public ``https://`` URL, defensively.

* `rewrite_share_link` (from `urlguard`, shared with the web backend) turns common share links into direct
  download URLs.
* `fetch_url` downloads with SSRF guards: https only, no credentials in the URL, every resolved address must
  be public, redirects followed manually (and re-checked), a size cap, a timeout and a content sniff.
* `read_fetched` parses the downloaded bytes into a DataFrame.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import unquote, urljoin, urlsplit

import httpx
import pandas as pd

from autotinker.data.sources import NA_VALUES, DataSourceError
from autotinker.data.urlguard import (
    Resolver,
    UrlRejected,
    check_url,
    is_public,
    looks_like_html,
    rewrite_share_link,
    system_resolve,
)

DataKind = Literal["csv", "tsv", "parquet"]

USER_AGENT = "autotinker/0.1 (+https://github.com/Sakalya100/AutoTabML)"
DEFAULT_MAX_BYTES = 50 * 1024 * 1024
_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
_SNIFF_BYTES = 8192


__all__ = [
    "DataKind",
    "FetchError",
    "FetchResult",
    "Resolver",
    "fetch_url",
    "is_public",
    "read_fetched",
    "rewrite_share_link",
]


class FetchError(DataSourceError):
    """Raised when a URL is rejected or its download fails."""


@dataclass(frozen=True)
class FetchResult:
    """Bytes downloaded from a URL plus what we learned about them."""

    content: bytes
    final_url: str
    kind: DataKind
    content_type: str | None
    filename: str


def _check_url(url: str, resolver: Resolver) -> None:
    """Reject anything that is not an https URL to a host whose every address is public (see urlguard)."""
    try:
        check_url(url, resolver)
    except UrlRejected as e:
        raise FetchError(str(e)) from e


# --------------------------------------------------------------------------------------------- sniffing


def _filename(url: str, content_disposition: str | None) -> str:
    if content_disposition:
        m = re.search(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?", content_disposition, re.IGNORECASE)
        if m:
            name = unquote(m.group(1)).strip().rsplit("/", 1)[-1]
            if name:
                return name
    parts = urlsplit(url)
    last = unquote(parts.path.rstrip("/").rsplit("/", 1)[-1]) if parts.path.strip("/") else ""
    return last or (parts.hostname or "download")


def _sniff(content: bytes, content_type: str | None, filename: str) -> DataKind:
    if not content:
        raise FetchError("the link returned an empty file")
    if content.startswith(b"PAR1"):
        return "parquet"
    head = content[:_SNIFF_BYTES]
    if looks_like_html(head, content_type):
        raise FetchError(
            "the link returned a web page, not a data file — use a direct/raw download link "
            "(e.g. the 'Raw' button on GitHub)"
        )
    lower_name = filename.lower()
    if lower_name.endswith((".parquet", ".pq")):
        raise FetchError("the link claims to be a parquet file but its contents are not valid parquet")
    if b"\x00" in head:
        raise FetchError("the link returned a binary file that is not CSV, TSV or parquet")
    if lower_name.endswith(".tsv") or "tab-separated" in (content_type or "").lower():
        return "tsv"
    lines = head.decode("utf-8", errors="ignore").splitlines()[:20]
    tabs = sum(line.count("\t") for line in lines)
    commas = sum(line.count(",") for line in lines)
    return "tsv" if tabs > commas else "csv"


# ---------------------------------------------------------------------------------------------- download


def fetch_url(
    url: str,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
    timeout_s: float = 15.0,
    max_redirects: int = 3,
    transport: httpx.BaseTransport | None = None,
    resolver: Resolver | None = None,
) -> FetchResult:
    """Download ``url`` (https only, public hosts only) and sniff whether it is CSV, TSV or parquet."""
    resolve = resolver or system_resolve
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/csv, text/tab-separated-values, application/octet-stream, */*;q=0.1",
    }
    current = url
    redirects = 0
    try:
        with httpx.Client(
            transport=transport, follow_redirects=False, timeout=timeout_s, headers=headers
        ) as client:
            while True:
                # Note: the address httpx connects to is resolved again by httpx, so a DNS-rebinding attacker
                # could still swap answers between our check and the connect (TOCTOU). Acceptable for Phase 1;
                # pinning the checked IP in a custom transport would close it.
                _check_url(current, resolve)
                with client.stream("GET", current) as resp:
                    if resp.status_code in _REDIRECT_CODES:
                        location = resp.headers.get("location")
                        if not location:
                            raise FetchError(
                                f"the server sent a redirect ({resp.status_code}) with no target"
                            )
                        redirects += 1
                        if redirects > max_redirects:
                            raise FetchError(f"too many redirects (more than {max_redirects})")
                        current = urljoin(current, location)
                        continue
                    if resp.status_code >= 400:
                        raise FetchError(f"the server answered HTTP {resp.status_code} for {current}")
                    declared = resp.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > max_bytes:
                        raise FetchError(f"the file is larger than the {max_bytes // (1024 * 1024)} MB limit")
                    buf = bytearray()
                    for chunk in resp.iter_bytes():
                        buf.extend(chunk)
                        if len(buf) > max_bytes:
                            raise FetchError(
                                f"the file is larger than the {max_bytes // (1024 * 1024)} MB limit"
                            )
                    content_type = resp.headers.get("content-type")
                    filename = _filename(current, resp.headers.get("content-disposition"))
                    content = bytes(buf)
                    break
    except httpx.TimeoutException as e:
        raise FetchError(f"the download timed out after {timeout_s:g} s") from e
    except httpx.HTTPError as e:
        raise FetchError(f"the download failed ({type(e).__name__})") from e

    kind = _sniff(content, content_type, filename)
    return FetchResult(
        content=content, final_url=current, kind=kind, content_type=content_type, filename=filename
    )


def read_fetched(res: FetchResult) -> pd.DataFrame:
    """Parse downloaded bytes into a DataFrame according to the sniffed kind."""
    if res.kind == "parquet":
        try:
            return pd.read_parquet(io.BytesIO(res.content))
        except ImportError as e:
            raise DataSourceError(
                "reading parquet needs 'pyarrow' (or 'fastparquet'); install it with `uv add pyarrow`"
            ) from e
        except Exception as e:  # any parser failure becomes a data source error
            raise DataSourceError(f"could not parse the downloaded parquet file: {e}") from e
    sep = "\t" if res.kind == "tsv" else ","
    last: Exception | None = None
    for encoding in ("utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(
                io.BytesIO(res.content), sep=sep, na_values=NA_VALUES, keep_default_na=True, encoding=encoding
            )
        except UnicodeDecodeError as e:
            last = e
        except (pd.errors.ParserError, pd.errors.EmptyDataError) as e:
            raise DataSourceError(f"could not parse the downloaded {res.kind.upper()} file: {e}") from e
    raise DataSourceError(f"could not decode the downloaded file as text: {last}")
