"""Tests for public-URL ingest: share-link rewriting, SSRF guards, sniffing. No real network access."""

from __future__ import annotations

import functools
import io
import socket
from collections.abc import Callable
from pathlib import Path

import httpx
import pandas as pd
import pytest

from autotinker.data import DataSourceError, fetch, load_source, rewrite_share_link, source_stem
from autotinker.data.fetch import FetchError, FetchResult, fetch_url, read_fetched

PUBLIC_IP = "93.184.216.34"
CSV = b"a,b,c\n1,x,2.5\n2,y,NA\n"


def public_resolver(host: str) -> list[str]:
    return [PUBLIC_IP]


def resolver_for(mapping: dict[str, list[str]]) -> Callable[[str], list[str]]:
    def resolve(host: str) -> list[str]:
        if host not in mapping:
            raise socket.gaierror(f"unknown host {host}")
        return mapping[host]

    return resolve


def transport(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def serve(body: bytes, **headers: str) -> httpx.MockTransport:
    return transport(lambda req: httpx.Response(200, content=body, headers=headers))


def never_called(req: httpx.Request) -> httpx.Response:
    raise AssertionError(f"unexpected request to {req.url}")


# ------------------------------------------------------------------------------------------- rewriting


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "https://github.com/o/r/blob/main/data/x.csv",
            "https://raw.githubusercontent.com/o/r/main/data/x.csv",
        ),
        (
            "https://github.com/o/r/raw/v1.0/x.csv?raw=true",
            "https://raw.githubusercontent.com/o/r/v1.0/x.csv",
        ),
        (
            "https://drive.google.com/file/d/ABC123/view?usp=sharing",
            "https://drive.google.com/uc?export=download&id=ABC123",
        ),
        (
            "https://drive.google.com/open?id=ABC123",
            "https://drive.google.com/uc?export=download&id=ABC123",
        ),
        (
            "https://docs.google.com/spreadsheets/d/SHEET/edit#gid=42",
            "https://docs.google.com/spreadsheets/d/SHEET/export?format=csv&gid=42",
        ),
        (
            "https://docs.google.com/spreadsheets/d/SHEET/edit?gid=7",
            "https://docs.google.com/spreadsheets/d/SHEET/export?format=csv&gid=7",
        ),
        (
            "https://docs.google.com/spreadsheets/d/SHEET/edit",
            "https://docs.google.com/spreadsheets/d/SHEET/export?format=csv",
        ),
        (
            "https://huggingface.co/datasets/o/r/blob/main/train.csv",
            "https://huggingface.co/datasets/o/r/resolve/main/train.csv",
        ),
        (
            "https://huggingface.co/o/model/blob/main/sub/x.parquet",
            "https://huggingface.co/o/model/resolve/main/sub/x.parquet",
        ),
        ("https://example.com/data.csv", "https://example.com/data.csv"),
        ("https://github.com/o/r", "https://github.com/o/r"),
    ],
)
def test_rewrite_share_link(url: str, expected: str) -> None:
    assert rewrite_share_link(url) == expected


# ---------------------------------------------------------------------------------------------- guards


@pytest.mark.parametrize(
    ("url", "match"),
    [
        ("http://example.com/x.csv", "https"),
        ("file:///etc/passwd", "https"),
        ("ftp://example.com/x.csv", "https"),
        ("data:text/csv,a,b", "https"),
        ("https://user:pw@example.com/x.csv", "credentials"),
        ("https://user@example.com/x.csv", "credentials"),
    ],
)
def test_scheme_and_credentials_rejected(url: str, match: str) -> None:
    with pytest.raises(FetchError, match=match):
        fetch_url(url, transport=transport(never_called), resolver=public_resolver)


@pytest.mark.parametrize(
    "addr",
    [
        "10.0.0.5",
        "172.16.3.4",
        "192.168.1.1",
        "127.0.0.1",
        "169.254.169.254",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "224.0.0.1",
        "ff02::1",
        "0.0.0.0",
        "100.64.0.1",
        "240.0.0.1",
    ],
)
def test_private_resolution_rejected(addr: str) -> None:
    with pytest.raises(FetchError, match="private or reserved"):
        fetch_url("https://evil.example/x.csv", transport=transport(never_called), resolver=lambda h: [addr])


def test_any_private_address_rejects() -> None:
    with pytest.raises(FetchError, match="private or reserved"):
        fetch_url(
            "https://mixed.example/x.csv",
            transport=transport(never_called),
            resolver=lambda h: [PUBLIC_IP, "127.0.0.1"],
        )


@pytest.mark.parametrize(
    "host", ["127.0.0.1", "[::1]", "169.254.169.254", "[::ffff:192.168.0.1]", "10.1.2.3"]
)
def test_literal_ip_hosts_rejected(host: str) -> None:
    def resolver(h: str) -> list[str]:
        raise AssertionError("literal IPs must not be resolved")

    with pytest.raises(FetchError, match="private or reserved"):
        fetch_url(f"https://{host}/x.csv", transport=transport(never_called), resolver=resolver)


def test_literal_public_ip_allowed() -> None:
    res = fetch_url(f"https://{PUBLIC_IP}/x.csv", transport=serve(CSV), resolver=public_resolver)
    assert res.kind == "csv"


def test_resolution_failure_rejected() -> None:
    with pytest.raises(FetchError, match="could not resolve"):
        fetch_url("https://nope.example/x.csv", transport=transport(never_called), resolver=resolver_for({}))
    with pytest.raises(FetchError, match="could not resolve"):
        fetch_url("https://empty.example/x.csv", transport=transport(never_called), resolver=lambda h: [])


def test_redirect_to_private_host_rejected() -> None:
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        return httpx.Response(302, headers={"location": "https://internal.example/secret.csv"})

    resolver = resolver_for({"public.example": [PUBLIC_IP], "internal.example": ["10.0.0.7"]})
    with pytest.raises(FetchError, match="private or reserved"):
        fetch_url("https://public.example/x.csv", transport=transport(handler), resolver=resolver)
    assert seen == ["https://public.example/x.csv"]


def test_redirect_to_http_rejected() -> None:
    handler = lambda req: httpx.Response(301, headers={"location": "http://public.example/x.csv"})  # noqa: E731
    with pytest.raises(FetchError, match="https"):
        fetch_url("https://public.example/x.csv", transport=transport(handler), resolver=public_resolver)


def test_too_many_redirects_rejected() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        n = int(req.url.params.get("n", "0"))
        return httpx.Response(302, headers={"location": f"/x.csv?n={n + 1}"})

    with pytest.raises(FetchError, match="too many redirects"):
        fetch_url("https://public.example/x.csv", transport=transport(handler), resolver=public_resolver)


def test_relative_redirect_followed() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/start":
            return httpx.Response(302, headers={"location": "files/data.csv"})
        if req.url.path == "/files/data.csv":
            assert req.headers["user-agent"].startswith("autotinker/")
            return httpx.Response(200, content=CSV, headers={"content-type": "text/csv"})
        return httpx.Response(404)

    res = fetch_url("https://public.example/start", transport=transport(handler), resolver=public_resolver)
    assert res.final_url == "https://public.example/files/data.csv"
    assert res.filename == "data.csv"
    assert res.kind == "csv"


def test_three_redirects_allowed() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        n = int(req.url.params.get("n", "0"))
        if n < 3:
            return httpx.Response(302, headers={"location": f"/x.csv?n={n + 1}"})
        return httpx.Response(200, content=CSV)

    res = fetch_url("https://public.example/x.csv", transport=transport(handler), resolver=public_resolver)
    assert res.final_url.endswith("n=3")


def test_http_error_status() -> None:
    with pytest.raises(FetchError, match="HTTP 404"):
        fetch_url(
            "https://public.example/x.csv",
            transport=transport(lambda r: httpx.Response(404)),
            resolver=public_resolver,
        )


def test_size_cap_via_content_length() -> None:
    handler = lambda req: httpx.Response(200, content=CSV, headers={"content-length": "999999999"})  # noqa: E731
    with pytest.raises(FetchError, match="larger than"):
        fetch_url(
            "https://public.example/x.csv",
            transport=transport(handler),
            resolver=public_resolver,
            max_bytes=1024,
        )


def test_size_cap_via_streamed_body() -> None:
    def chunks() -> object:
        for _ in range(100):
            yield b"a,b\n" * 64

    handler = lambda req: httpx.Response(200, content=chunks())  # type: ignore[arg-type]  # noqa: E731
    with pytest.raises(FetchError, match="larger than"):
        fetch_url(
            "https://public.example/x.csv",
            transport=transport(handler),
            resolver=public_resolver,
            max_bytes=1024,
        )


def test_timeout_reported() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=req)

    with pytest.raises(FetchError, match="timed out"):
        fetch_url("https://public.example/x.csv", transport=transport(handler), resolver=public_resolver)


# -------------------------------------------------------------------------------------------- sniffing


@pytest.mark.parametrize(
    ("body", "ctype"),
    [
        (b"  <!DOCTYPE html><html><body>Sign in</body></html>", "text/html"),
        (b"<html><head></head></html>", "application/octet-stream"),
        (b"\n<head><title>x</title></head>", "text/html; charset=utf-8"),
    ],
)
def test_html_page_rejected(body: bytes, ctype: str) -> None:
    with pytest.raises(FetchError, match="web page"):
        fetch_url(
            "https://public.example/x.csv",
            transport=serve(body, **{"content-type": ctype}),
            resolver=public_resolver,
        )


def test_binary_rejected() -> None:
    with pytest.raises(FetchError, match="binary"):
        fetch_url(
            "https://public.example/x.bin", transport=serve(b"\x89PNG\x00\x00\x01"), resolver=public_resolver
        )


def test_empty_rejected() -> None:
    with pytest.raises(FetchError, match="empty"):
        fetch_url("https://public.example/x.csv", transport=serve(b""), resolver=public_resolver)


def test_csv_parsed() -> None:
    res = fetch_url("https://public.example/x.csv", transport=serve(CSV), resolver=public_resolver)
    assert res.kind == "csv"
    df = read_fetched(res)
    assert list(df.columns) == ["a", "b", "c"]
    assert df["c"].isna().sum() == 1


def test_tsv_sniffed() -> None:
    body = b"name\tnote\tv\nx\thello, world\t1\ny\ta, b, c\t2\n"
    res = fetch_url("https://public.example/download", transport=serve(body), resolver=public_resolver)
    assert res.kind == "tsv"
    df = read_fetched(res)
    assert list(df.columns) == ["name", "note", "v"]
    assert df.loc[0, "note"] == "hello, world"


def test_tsv_extension_hint() -> None:
    res = fetch_url("https://public.example/x.tsv", transport=serve(b"a\n1\n"), resolver=public_resolver)
    assert res.kind == "tsv"


def test_content_disposition_filename() -> None:
    body_headers = {"content-disposition": 'attachment; filename="sales.csv"'}
    res = fetch_url(
        "https://public.example/uc", transport=serve(CSV, **body_headers), resolver=public_resolver
    )
    assert res.filename == "sales.csv"


def test_parquet_sniffed() -> None:
    pytest.importorskip("pyarrow")
    buf = io.BytesIO()
    pd.DataFrame({"a": [1, 2], "b": ["x", "y"]}).to_parquet(buf)
    res = fetch_url("https://public.example/blob", transport=serve(buf.getvalue()), resolver=public_resolver)
    assert res.kind == "parquet"
    assert read_fetched(res).shape == (2, 2)


def test_parquet_extension_with_bad_bytes() -> None:
    with pytest.raises(FetchError, match="parquet"):
        fetch_url("https://public.example/x.parquet", transport=serve(CSV), resolver=public_resolver)


def test_read_fetched_parquet_without_engine() -> None:
    res = FetchResult(content=b"PAR1garbage", final_url="u", kind="parquet", content_type=None, filename="x")
    with pytest.raises(DataSourceError):
        read_fetched(res)


# ---------------------------------------------------------------------------------------- load_source


def test_load_source_https_end_to_end(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        return httpx.Response(200, content=b" a ,b\n1,2\n3,4\n")

    patched = functools.partial(fetch_url, transport=transport(handler), resolver=public_resolver)
    monkeypatch.setattr(fetch, "fetch_url", patched)
    df = load_source("https://github.com/o/r/blob/main/x.csv")
    assert seen == ["https://raw.githubusercontent.com/o/r/main/x.csv"]
    assert list(df.columns) == ["a", "b"]
    assert df.shape == (2, 2)


def test_load_source_rejects_http() -> None:
    with pytest.raises(DataSourceError, match="https"):
        load_source("http://example.com/x.csv")
    with pytest.raises(DataSourceError, match="https"):
        load_source("file:///etc/passwd")


# ----------------------------------------------------------------------------------------- source_stem


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        ("https://raw.githubusercontent.com/o/r/main/data/iris.csv", "iris"),
        ("https://example.com/", "example.com"),
        ("https://drive.google.com/uc?export=download&id=X", "drive.google.com"),
        ("https://example.com/my%20data.tsv", "my-data"),
        ("examples/data/titanic.csv", "titanic"),
        (Path("/tmp/x/house prices.parquet"), "house-prices"),
        ("openml:31", "openml-31"),
        ("kaggle:owner/ds/file.csv", "kaggle-owner-ds-file.csv"),
    ],
)
def test_source_stem(spec: str | Path, expected: str) -> None:
    assert source_stem(spec) == expected


def test_dropbox_share_link_downloads_the_file() -> None:
    assert (
        rewrite_share_link("https://www.dropbox.com/s/abc/data.csv?dl=0")
        == "https://www.dropbox.com/s/abc/data.csv?dl=1"
    )
    assert rewrite_share_link("https://www.dropbox.com/s/abc/data.csv?dl=1").endswith("?dl=1")
