"""URL guards shared by the engine's downloader and the web backend's link preview. Standard library only.

* `rewrite_share_link` turns common share links (GitHub, Google Drive / Sheets, Hugging Face, Dropbox) into
  direct download URLs.
* `check_url` rejects anything that is not an ``https://`` URL to a host whose every address is public
  (SSRF guard). Callers follow redirects themselves and re-check every hop.
* `looks_like_html` spots a web page served where a data file was expected.

The backend (backend/autotinker_api/urlguard.py) carries a byte-identical copy of this file, because it is
deployed without the engine's heavy dependencies; a backend test fails if the two drift apart.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable
from typing import Literal
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

Resolver = Callable[[str], list[str]]
RejectCode = Literal["invalid_url", "not_https", "credentials", "blocked_host", "dns"]


class UrlRejected(ValueError):
    """The URL is not allowed. `code` is machine-readable; `host` is the host name when there was one."""

    def __init__(self, code: RejectCode, message: str, host: str = "") -> None:
        super().__init__(message)
        self.code: RejectCode = code
        self.host = host


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

    if host in ("www.dropbox.com", "dropbox.com") and query.get("dl", [""])[0] != "1":
        query["dl"] = ["1"]
        return urlunsplit(parts._replace(query=urlencode(query, doseq=True)))

    return url


# ------------------------------------------------------------------------------------------------ guards


def system_resolve(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    return sorted({str(info[4][0]) for info in infos})


def is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped or ip.sixtofour
        if mapped is not None:
            return is_public(mapped)
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


def check_url(url: str, resolver: Resolver | None = None) -> None:
    """Reject anything that is not an https URL to a host whose every address is public."""
    resolve = resolver or system_resolve
    try:
        parts = urlsplit(url)
        port = parts.port  # raises ValueError on garbage ports
    except ValueError as e:
        raise UrlRejected("invalid_url", f"not a valid URL: {url!r}") from e
    scheme = parts.scheme.lower()
    if scheme == "http":
        raise UrlRejected(
            "not_https", "only https:// links are supported (got http://); use the https version of the link"
        )
    if scheme != "https":
        raise UrlRejected("not_https", f"only https:// links are supported (got '{scheme or 'no'}' scheme)")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise UrlRejected(
            "credentials", "links with embedded credentials (user:password@host) are not allowed"
        )
    host = parts.hostname
    if not host:
        raise UrlRejected("invalid_url", "the link has no host name")
    if port is not None and not 0 < port < 65536:
        raise UrlRejected("invalid_url", "the link has an invalid port", host)

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        addresses = [str(literal)]
    else:
        try:
            addresses = resolve(host)
        except (OSError, UnicodeError) as e:
            raise UrlRejected("dns", f"could not resolve host '{host}'", host) from e
        if not addresses:
            raise UrlRejected("dns", f"could not resolve host '{host}'", host)

    for addr in addresses:
        try:
            ip = ipaddress.ip_address(addr.split("%", 1)[0])
        except ValueError as e:
            raise UrlRejected(
                "blocked_host", f"host '{host}' resolved to an unrecognised address", host
            ) from e
        if not is_public(ip):
            raise UrlRejected(
                "blocked_host",
                f"host '{host}' points at a private or reserved network address ({ip}); "
                "only public internet hosts are allowed",
                host,
            )


# --------------------------------------------------------------------------------------------- sniffing


def looks_like_html(head: bytes, content_type: str | None) -> bool:
    text = head.lstrip(b"\xef\xbb\xbf").lstrip().lower()
    if text.startswith((b"<!doctype html", b"<html")):
        return True
    ctype = (content_type or "").lower()
    return "text/html" in ctype and any(
        tag in text[:2048] for tag in (b"<html", b"<!doctype", b"<head", b"<body")
    )
