"""Download a tabular data file from a public ``https://`` URL, defensively.

* `rewrite_share_link` turns common share links (GitHub, Google Drive / Sheets, Hugging Face) into direct
  download URLs.
* `fetch_url` downloads with SSRF guards: https only, no credentials in the URL, every resolved address must
  be public, redirects followed manually (and re-checked), a size cap, a timeout and a content sniff.
* `read_fetched` parses the downloaded bytes into a DataFrame.
"""

from __future__ import annotations

import io
import ipaddress
import re
import socket
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

import httpx
import pandas as pd

from autotinker.data.sources import NA_VALUES, DataSourceError

DataKind = Literal["csv", "tsv", "parquet"]
Resolver = Callable[[str], list[str]]

USER_AGENT = "autotinker/0.1 (+https://github.com/Sakalya100/AutoTabML)"
DEFAULT_MAX_BYTES = 50 * 1024 * 1024
_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
_SNIFF_BYTES = 8192


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


# --------------------------------------------------------------------------------------------- share links


def rewrite_share_link(url: str) -> str:
    """Rewrite a known share/preview link into a direct-download URL; other URLs are returned unchanged."""
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    segs = [s for s in parts.path.split("/") if s]
    query = parse_qs(parts.query)

    if host in ("github.com", "www.github.com") and len(segs) >= 5 and segs[2] in ("blob", "raw"):
        owner, repo, _, ref, *rest = segs
        return f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{'/'.join(rest)}"

    if host == "drive.google.com":
        file_id: str | None = None
        if len(segs) >= 3 and segs[0] == "file" and segs[1] == "d":
            file_id = segs[2]
        elif segs and segs[0] in ("open", "uc") and query.get("id"):
            file_id = query["id"][0]
        if file_id:
            return f"https://drive.google.com/uc?export=download&id={file_id}"

    if host == "docs.google.com" and len(segs) >= 3 and segs[0] == "spreadsheets" and segs[1] == "d":
        out = f"https://docs.google.com/spreadsheets/d/{segs[2]}/export?format=csv"
        gid = query.get("gid") or parse_qs(parts.fragment).get("gid")
        return f"{out}&gid={gid[0]}" if gid else out

    if host in ("huggingface.co", "www.huggingface.co"):
        offset = 1 if segs and segs[0] in ("datasets", "spaces") else 0
        idx = offset + 2
        if len(segs) > idx + 2 and segs[idx] == "blob":
            segs[idx] = "resolve"
            return f"https://huggingface.co/{'/'.join(segs)}"

    return url


# ------------------------------------------------------------------------------------------------ guards


def _system_resolve(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    return sorted({str(info[4][0]) for info in infos})


def _is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped or ip.sixtofour
        if mapped is not None:
            return _is_public(mapped)
        if ip.is_site_local:
            return False
    blocked = (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )
    return not blocked and ip.is_global


def _check_url(url: str, resolver: Resolver) -> None:
    """Reject anything that is not an https URL to a host whose every address is public."""
    try:
        parts = urlsplit(url)
        port = parts.port  # raises ValueError on garbage ports
    except ValueError as e:
        raise FetchError(f"not a valid URL: {url!r}") from e
    scheme = parts.scheme.lower()
    if scheme == "http":
        raise FetchError("only https:// links are supported (got http://); use the https version of the link")
    if scheme != "https":
        raise FetchError(f"only https:// links are supported (got '{scheme or 'no'}' scheme)")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise FetchError("links with embedded credentials (user:password@host) are not allowed")
    host = parts.hostname
    if not host:
        raise FetchError("the link has no host name")
    if port is not None and not 0 < port < 65536:
        raise FetchError("the link has an invalid port")

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        addresses = [str(literal)]
    else:
        try:
            addresses = resolver(host)
        except (OSError, UnicodeError) as e:
            raise FetchError(f"could not resolve host '{host}'") from e
        if not addresses:
            raise FetchError(f"could not resolve host '{host}'")

    for addr in addresses:
        try:
            ip = ipaddress.ip_address(addr.split("%", 1)[0])
        except ValueError as e:
            raise FetchError(f"host '{host}' resolved to an unrecognised address") from e
        if not _is_public(ip):
            raise FetchError(
                f"host '{host}' points at a private or reserved network address ({ip}); "
                "only public internet hosts are allowed"
            )


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


def _looks_like_html(head: bytes, content_type: str | None) -> bool:
    text = head.lstrip(b"\xef\xbb\xbf").lstrip().lower()
    if text.startswith((b"<!doctype html", b"<html")):
        return True
    ctype = (content_type or "").lower()
    return "text/html" in ctype and any(
        tag in text[:2048] for tag in (b"<html", b"<!doctype", b"<head", b"<body")
    )


def _sniff(content: bytes, content_type: str | None, filename: str) -> DataKind:
    if not content:
        raise FetchError("the link returned an empty file")
    if content.startswith(b"PAR1"):
        return "parquet"
    head = content[:_SNIFF_BYTES]
    if _looks_like_html(head, content_type):
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
    resolve = resolver or _system_resolve
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
