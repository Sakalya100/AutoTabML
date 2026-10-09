"""Link preview: SSRF guard (the engine's), share-link rewrites, the guarded fetch, CSV parsing/profiling and the
suggestion heuristics (ported from the web client's tests so both implementations stay in step). No network."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from autotinker_api import urlguard
from autotinker_api.preview.csvparse import parse_delimited, parse_table, profile_column, sniff_delimiter
from autotinker_api.preview.llm import build_messages, parse_llm_suggestion
from autotinker_api.preview.service import PreviewError, build_preview, check_url, fetch_head, suggest_for
from autotinker_api.preview.suggest import suggest, suggestion_for


def test_urlguard_is_a_verbatim_copy_of_the_engines() -> None:
    engine = Path(__file__).resolve().parents[2] / "src" / "autotinker" / "data" / "urlguard.py"
    ours = Path(urlguard.__file__)
    assert ours.read_bytes() == engine.read_bytes(), "run: cp src/autotinker/data/urlguard.py backend/autotinker_api/"


@pytest.mark.parametrize(
    ("link", "direct"),
    [
        ("https://github.com/o/r/blob/main/data/x.csv", "https://raw.githubusercontent.com/o/r/main/data/x.csv"),
        (
            "https://drive.google.com/file/d/ABC123/view?usp=sharing",
            "https://drive.google.com/uc?export=download&id=ABC123",
        ),
        (
            "https://docs.google.com/spreadsheets/d/S/edit#gid=42",
            "https://docs.google.com/spreadsheets/d/S/export?format=csv&gid=42",
        ),
        (
            "https://huggingface.co/datasets/o/r/blob/main/train.csv",
            "https://huggingface.co/datasets/o/r/resolve/main/train.csv",
        ),
        ("https://www.dropbox.com/s/abc/x.csv?dl=0", "https://www.dropbox.com/s/abc/x.csv?dl=1"),
        ("https://www.dropbox.com/scl/fi/abc/x.csv?rlkey=k", "https://www.dropbox.com/scl/fi/abc/x.csv?rlkey=k&dl=1"),
        ("https://example.com/data.csv", "https://example.com/data.csv"),
    ],
)
def test_share_links(link: str, direct: str) -> None:
    assert urlguard.rewrite_share_link(link) == direct


def resolver_of(table: dict[str, list[str]]) -> Callable[[str], list[str]]:
    def resolve(host: str) -> list[str]:
        if host not in table:
            raise OSError("ENOTFOUND")
        return table[host]

    return resolve


@pytest.mark.parametrize(
    ("url", "code"),
    [
        ("https://public.example/x.csv", None),
        ("http://public.example/x.csv", "not_https"),
        ("file:///etc/passwd", "not_https"),
        ("https://user:pw@public.example/x.csv", "credentials"),
        ("https://evil.example/x.csv", "blocked_host"),  # any private answer blocks
        ("https://127.0.0.1/x.csv", "blocked_host"),
        ("https://[::1]/x.csv", "blocked_host"),
        ("https://169.254.169.254/latest/meta-data", "blocked_host"),
        ("https://[::ffff:10.0.0.1]/x.csv", "blocked_host"),
        ("https://nowhere.example/x.csv", "dns"),
    ],
)
def test_ssrf_guard(url: str, code: str | None) -> None:
    resolve = resolver_of({"public.example": ["93.184.216.34"], "evil.example": ["93.184.216.34", "10.0.0.5"]})
    try:
        asyncio.run(check_url(url, resolve))
        got = None
    except PreviewError as e:
        got = e.code
        assert e.message and "'" not in e.message[:1]
    assert got == code


RESOLVE = resolver_of(
    {
        "a.example": ["93.184.216.34"],
        "b.example": ["93.184.216.35"],
        "internal.example": ["192.168.0.10"],
        "raw.githubusercontent.com": ["185.199.108.133"],
    }
)


def serve(routes: dict[str, Callable[[], httpx.Response]]) -> httpx.MockTransport:
    def handler(req: httpx.Request) -> httpx.Response:
        r = routes.get(str(req.url))
        return r() if r else httpx.Response(404, text="missing")

    return httpx.MockTransport(handler)


def redirect(to: str, status: int = 302) -> Callable[[], httpx.Response]:
    return lambda: httpx.Response(status, headers={"location": to})


def csv(body: str, **headers: str) -> Callable[[], httpx.Response]:
    return lambda: httpx.Response(200, content=body.encode(), headers={"content-type": "text/csv", **headers})


def code_of(coro: Any) -> str:
    try:
        asyncio.run(coro)
    except PreviewError as e:
        return e.code
    return "ok"


def test_fetch_follows_public_redirects_and_blocks_private_ones() -> None:
    t = serve(
        {"https://a.example/x.csv": redirect("https://b.example/y.csv"), "https://b.example/y.csv": csv("a,b\n1,2\n")}
    )
    head = asyncio.run(fetch_head("https://a.example/x.csv", resolver=RESOLVE, transport=t))
    assert head.final_url == "https://b.example/y.csv" and head.text == "a,b\n1,2\n"
    for target, code in [
        ("https://internal.example/s.csv", "blocked_host"),
        ("https://169.254.169.254/", "blocked_host"),
        ("http://b.example/x.csv", "not_https"),
    ]:
        t = serve({"https://a.example/x.csv": redirect(target)})
        assert code_of(fetch_head("https://a.example/x.csv", resolver=RESOLVE, transport=t)) == code
    hops = serve({f"https://a.example/{i}": redirect(f"/{i + 1}") for i in range(1, 5)})
    assert code_of(fetch_head("https://a.example/1", resolver=RESOLVE, transport=hops)) == "too_many_redirects"


def test_fetch_errors() -> None:
    assert code_of(fetch_head("https://a.example/nope.csv", resolver=RESOLVE, transport=serve({}))) == "not_found"
    t = serve({"https://a.example/x.csv": lambda: httpx.Response(403)})
    assert code_of(fetch_head("https://a.example/x.csv", resolver=RESOLVE, transport=t)) == "http_error"
    t = serve({"https://a.example/x.csv": csv("a,b\n", **{"content-length": str(80 * 1024 * 1024)})})
    assert code_of(fetch_head("https://a.example/x.csv", resolver=RESOLVE, transport=t)) == "too_big"

    def slow(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=req)

    assert (
        code_of(fetch_head("https://a.example/x.csv", resolver=RESOLVE, transport=httpx.MockTransport(slow)))
        == "timeout"
    )


def test_preview_rejects_pages_and_archives() -> None:
    page = "<!DOCTYPE html><html><body>Google Drive can't scan this file</body></html>"
    for body, ctype, code in [
        (page, "text/html", "html"),
        ("PAR1\x00\x01", "", "not_csv"),
        ("PK\x03\x04xx", "", "not_csv"),
    ]:
        t = serve(
            {
                "https://a.example/x.csv": lambda b=body, c=ctype: httpx.Response(
                    200, text=b, headers={"content-type": c}
                )
            }
        )
        assert code_of(build_preview("https://a.example/x.csv", resolver=RESOLVE, transport=t)) == code


def test_preview_partial_read_estimates_rows() -> None:
    body = "x,y\n" + "\n".join(f"{i},{i % 2}" for i in range(1000)) + "\n"
    t = serve({"https://a.example/x.csv": csv(body, **{"content-length": str(len(body))})})
    p = asyncio.run(build_preview("https://a.example/x.csv", resolver=RESOLVE, transport=t, max_bytes=2000))
    assert p["rowsExact"] is False and 800 < p["rows"] < 1200 and p["columns"] == ["x", "y"]


def test_preview_rewrites_a_share_link() -> None:
    t = serve({"https://raw.githubusercontent.com/o/r/main/x.csv": csv("a,b\n1,2\n")})
    p = asyncio.run(build_preview("https://github.com/o/r/blob/main/x.csv", resolver=RESOLVE, transport=t))
    assert p["rewritten"] is True and p["resolvedUrl"] == "https://raw.githubusercontent.com/o/r/main/x.csv"
    assert p["rows"] == 1 and p["rowsExact"] is True and p["sizeBytes"] == 8
    json.dumps(p)  # serialisable


# --------------------------------------------------------------------------------------------------------- CSV


def test_sniff_delimiter() -> None:
    assert sniff_delimiter("a,b,c\n1,2,3\n") == ","
    assert sniff_delimiter("a;b;c\n1,5;2,5;3\n") == ";"
    assert sniff_delimiter("a\tb\n1\t2\n") == "\t"
    assert sniff_delimiter("a|b\n1|2\n") == "|"
    assert sniff_delimiter('"x, y";b\n"1, 2";3\n') == ";"


def test_parse_quotes_bom_crlf_and_partial() -> None:
    rows = parse_delimited('﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nAnn,ok\r\n', ",")
    assert rows == [["name", "note"], ["Smith, J", 'said "hi"\nthen left'], ["Ann", "ok"]]
    assert parse_delimited("a,b\n1,2\n3,4", ",", partial=True) == [["a", "b"], ["1", "2"]]
    assert parse_delimited("a,b\n1,2\n3,4", ",") == [["a", "b"], ["1", "2"], ["3", "4"]]
    t = parse_table("a,,c\n1,2\n")
    assert t["columns"] == ["a", "column_2", "c"] and t["sample"][0] == ["1", "2", ""]


def test_column_kinds() -> None:
    def kind(name: str, vals: list[str]) -> str:
        return str(profile_column(name, vals)["kind"])

    assert kind("age", ["22", "38", "", "NA", "35"]) == "integer"
    assert kind("fare", ["7.25", "71.2833", "8.05"]) == "numeric"
    assert kind("Survived", ["0", "1", "1", "0"]) == "boolean"
    assert kind("smoker", ["yes", "no", "no"]) == "boolean"
    assert kind("Sex", ["male", "female", "male", "female"]) == "categorical"
    assert kind("date", ["2024-01-02", "2024-02-03", "2024-03-04"]) == "datetime"
    assert kind("PassengerId", [str(i + 1) for i in range(30)]) == "id"
    assert kind("empty", ["", "NA", "?"]) == "empty"
    s = profile_column("Survived", ["0", "1", "1", "0", ""])
    assert s == {
        "name": "Survived",
        "count": 4,
        "missing": 1,
        "unique": 2,
        "minCount": 2,
        "kind": "boolean",
        "min": 0,
        "max": 1,
    }


# ------------------------------------------------------------------------------------------------- heuristics


def col(name: str, kind: str, unique: int, n: int = 500, missing: int = 0) -> dict[str, Any]:
    return {"name": name, "kind": kind, "unique": unique, "count": n - missing, "missing": missing}


def test_suggestions_on_real_headers() -> None:
    titanic = [
        col("PassengerId", "id", 891, 891),
        col("Survived", "boolean", 2, 891),
        col("Pclass", "integer", 3, 891),
        col("Name", "text", 891, 891),
        col("Sex", "categorical", 2, 891),
        col("Age", "numeric", 88, 891, 177),
        col("Fare", "numeric", 248, 891),
        col("Embarked", "categorical", 3, 891, 2),
    ]
    s = suggest(titanic)
    assert s and (s["target"], s["problemType"], s["metric"], s["ambiguous"]) == (
        "Survived",
        "binary",
        "roc_auc",
        False,
    )
    breast = [
        col("Id", "integer", 645, 699),
        *[col(f"f{i}", "integer", 10, 699) for i in range(8)],
        col("Class", "boolean", 2, 699),
    ]
    assert (suggest(breast) or {})["target"] == "Class"
    iris = [col("Id", "id", 150, 150), col("SepalLengthCm", "numeric", 35, 150), col("Species", "categorical", 3, 150)]
    assert (suggest(iris) or {})["problemType"] == "multiclass"
    adult = [
        col("age", "integer", 73, 32561),
        col("hours.per.week", "integer", 94, 32561),
        col("income", "categorical", 2, 32561),
    ]
    assert (suggest(adult) or {})["target"] == "income"
    assert (suggest(adult, "predict how many hours per week people work") or {})["target"] == "hours.per.week"
    flat = suggest([col("a", "numeric", 100), col("b", "numeric", 100), col("c", "numeric", 100)])
    assert flat and flat["ambiguous"] and flat["target"] == "c"
    stats = [col("x", "numeric", 100, 1000), col("y", "integer", 30, 1000), col("z", "integer", 15, 1000)]
    assert suggestion_for(stats, "y", "")["problemType"] == "regression"
    assert suggestion_for(stats, "z", "")["problemType"] == "multiclass"


def test_llm_prompt_privacy_and_validation() -> None:
    stats = [col("age", "integer", 50, 100), col("churn", "categorical", 2, 100)]
    sample = [["31", "yes"], ["45", "no"]]
    gemini = json.dumps(build_messages(stats, sample, "who leaves", None, False))
    assert "First rows" not in gemini and '\\"31\\"' not in gemini
    assert "First rows" in json.dumps(build_messages(stats, sample, "who leaves", None, True))
    assert parse_llm_suggestion('{"target":"nope"}', stats) is None
    assert parse_llm_suggestion("not json", stats) is None
    text = '```json\n{"target":"churn","problem_type":"binary","metric":"rmse","goal_plain":"Predict churn"}\n```'
    assert parse_llm_suggestion(text, stats) == {
        "target": "churn",
        "source": "llm",
        "problemType": "binary",
        "goalPlain": "Predict churn",
    }


def test_suggest_for_uses_the_llm_only_when_it_helps() -> None:
    stats = [col("age", "integer", 50, 100), col("churn", "categorical", 2, 100)]
    preview = {"stats": stats, "sample": [["31", "yes"]]}
    sure = asyncio.run(suggest_for(preview, "", groq_key="k", gemini_key=None))
    assert sure[1] == "skipped" and sure[0] and sure[0]["target"] == "churn"
    assert asyncio.run(suggest_for(preview, "who leaves", groq_key=None, gemini_key=None))[1] == "unavailable"

    def groq(req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer k"
        content = json.dumps({"target": "age", "problem_type": "regression", "metric": "mae", "why": "asked"})
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    out, llm = asyncio.run(
        suggest_for(preview, "predict age", groq_key="k", gemini_key=None, transport=httpx.MockTransport(groq))
    )
    assert llm == "used" and out and (out["target"], out["metric"], out["source"]) == ("age", "mae", "llm")
