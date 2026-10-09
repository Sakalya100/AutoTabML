"""Delimiter / encoding / decimal detection, the run CLI's format flags, and plain-language failure events."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest
from typer.testing import CliRunner

from autotinker import cli
from autotinker.data import load_source
from autotinker.data.csvformat import (
    CsvFormat,
    CsvFormatError,
    detect_format,
    normalise_format,
    sniff_decimal,
    sniff_delimiter,
)
from autotinker.data.fetch import FetchError, FetchResult, read_fetched
from autotinker.failures import RunError, check_data, classify, target_missing
from autotinker.obs.events import parse_event

FIX = Path(__file__).resolve().parent / "fixtures" / "csv"
runner = CliRunner()


# ------------------------------------------------------------------------------------------------- detection


@pytest.mark.parametrize(
    ("name", "delimiter", "encoding", "decimal"),
    [
        ("semicolon.csv", ";", "utf-8", "."),
        ("tab.tsv", "\t", "utf-8", "."),
        ("bom.csv", ",", "utf-8-sig", "."),
        ("latin1_pipe.csv", "|", "cp1252", "."),
        ("decimal_comma.csv", ";", "utf-8", ","),
    ],
)
def test_detect_format(name: str, delimiter: str, encoding: str, decimal: str) -> None:
    assert detect_format((FIX / name).read_bytes()) == CsvFormat(delimiter, encoding, decimal)


def test_semicolon_with_quoted_header_reads_every_column() -> None:
    df = load_source(FIX / "semicolon.csv")
    assert list(df.columns) == ["fixed acidity", "volatile acidity", "quality"]
    assert df.shape == (30, 3)
    assert pd.api.types.is_float_dtype(df["fixed acidity"])


def test_tab_bom_latin1_and_decimal_comma() -> None:
    assert load_source(FIX / "tab.tsv").shape == (30, 3)
    bom = load_source(FIX / "bom.csv")
    assert list(bom.columns) == ["id", "score", "label"]  # no BOM glued to "id", no \r in "label"
    assert set(bom["label"]) == {"yes", "no"}
    lat = load_source(FIX / "latin1_pipe.csv")
    assert list(lat.columns) == ["ciudad", "año", "precio"]
    assert {"Málaga", "Cádiz", "León"} >= set(lat["ciudad"])
    dec = load_source(FIX / "decimal_comma.csv")
    assert list(dec.columns) == ["Länge", "Breite", "Klasse"]
    assert pd.api.types.is_float_dtype(dec["Länge"]) and dec["Länge"].between(4, 15).all()


def test_explicit_format_wins_over_detection() -> None:
    # Forced to a comma, the semicolon file is one column: proof the flag is honoured, not re-sniffed.
    df = load_source(FIX / "semicolon.csv", CsvFormat(delimiter=","))
    assert df.shape[1] == 1
    dec = load_source(FIX / "decimal_comma.csv", CsvFormat(";", "utf-8", ","))
    assert dec["Breite"].dtype.kind == "f"


def test_wrong_explicit_encoding_falls_back() -> None:
    # The preview saw only valid UTF-8 at the top; a Latin-1 byte further down must not fail the run.
    df = load_source(FIX / "latin1_pipe.csv", CsvFormat("|", "utf-8", "."))
    assert "año" in df.columns


def test_downloaded_bytes_use_the_same_reader() -> None:
    content = (FIX / "decimal_comma.csv").read_bytes()
    res = FetchResult(
        content=content, final_url="https://x/d.csv", kind="csv", content_type=None, filename="d.csv"
    )
    df = read_fetched(res)
    assert df.shape == (30, 3) and df["Länge"].dtype.kind == "f"
    tsv = FetchResult(
        content=(FIX / "tab.tsv").read_bytes(),
        final_url="https://x/t",
        kind="tsv",
        content_type=None,
        filename="t",
    )
    assert read_fetched(tsv).shape == (30, 3)


def test_sniffers_match_the_preview_rules() -> None:
    assert sniff_delimiter('"a;b",c,d\n1,2,3\n') == ","  # separators inside quotes don't count
    assert sniff_delimiter("a|b\n1|2\n") == "|"
    assert sniff_delimiter("single\n1\n") == ","
    assert sniff_decimal("a;b\n1,5;2\n", ";") == ","
    assert sniff_decimal("a;b\n1,5;2.5\n", ";") == "."  # mixed: not a decimal-comma file
    assert sniff_decimal('a;b\n"1,5";2\n', ";") == "."  # quoted text is not a number
    assert sniff_decimal("a,b\n1,5\n", ",") == "."


def test_normalise_format_spellings() -> None:
    assert normalise_format("tab", "UTF8", ",") == CsvFormat("\t", "utf-8", ",")
    assert normalise_format(";", "latin1", ".") == CsvFormat(";", "latin-1", ".")
    assert normalise_format(None, None, None) == CsvFormat()
    for bad in (("x", None, None), (None, "ebcdic", None), (None, None, ";")):
        with pytest.raises(CsvFormatError):
            normalise_format(*bad)


# --------------------------------------------------------------------------------------------------- failures


def test_target_missing_lists_close_matches() -> None:
    f = target_missing("qualty", ["fixed acidity", "quality", "alcohol"]).failure
    assert f.code == "target_missing" and '"qualty"' in f.message and '"quality"' in f.hint
    f = target_missing("Quality", ["quality", "x"]).failure
    assert '"quality"' in f.hint
    f = target_missing("quality", ['fixed acidity;"quality"']).failure
    assert "separator" in f.hint


def test_check_data_codes() -> None:
    def code(df: pd.DataFrame, target: str | None) -> str:
        with pytest.raises(RunError) as e:
            check_data(df, target)
        return e.value.failure.code

    assert code(pd.DataFrame({"a": range(30)}), None) == "not_csv"
    assert code(pd.DataFrame({"a": range(30), "y": [None] * 30}), "y") == "target_empty"
    assert code(pd.DataFrame({"a": range(30), "y": [1] * 30}), "y") == "target_empty"
    assert code(pd.DataFrame({"a": range(5), "y": [0, 1, 0, 1, 0]}), "y") == "too_few_rows"
    assert code(pd.DataFrame({"a": range(30), "y": [0, 1] * 15}), "z") == "target_missing"
    check_data(pd.DataFrame({"a": range(30), "y": [0, 1] * 15}), "y")


def test_classify_exceptions() -> None:
    from autotinker.agent.llm import LLMError
    from autotinker.agent.roles.base import RoleFailed
    from autotinker.contracts import AgentStep

    assert classify(FetchError("the server answered HTTP 404 for https://x")).code == "download_failed"
    assert classify(FetchError("the link returned a web page", code="not_csv")).code == "not_csv"
    assert classify(MemoryError()).code == "out_of_memory"
    assert classify(LLMError("no provider could serve alias 'big'")).code == "llm_unavailable"
    try:
        try:
            raise LLMError("all providers are rate-limited")
        except LLMError as inner:
            raise RoleFailed("planner failed", AgentStep(role="planner")) from inner
    except RoleFailed as outer:
        assert classify(outer).code == "llm_unavailable"
    f = classify(KeyError("boom"))
    assert f.code == "unexpected" and "KeyError" in f.detail and "Traceback" not in f.detail


# ------------------------------------------------------------------------------------------------------- CLI


@pytest.fixture
def no_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    for k in ("GROQ_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(cli, "load_env_file", lambda: None)
    return tmp_path


def _events(stdout: str) -> list[dict[str, object]]:
    lines = [ln for ln in stdout.splitlines() if ln.strip()]
    for ln in lines:
        parse_event(ln)  # stdout stays pure JSONL
    return [json.loads(ln) for ln in lines]


def test_cli_bad_target_ends_with_run_failed_event(no_env: Path) -> None:
    res = runner.invoke(
        cli.app,
        ["run", str(FIX / "semicolon.csv"), "--target", "qualty", "--out", str(no_env), "--events-stdout"],
    )
    assert res.exit_code == 2
    (ev,) = _events(res.stdout)
    assert ev["type"] == "run_failed" and ev["code"] == "target_missing" and ev["seq"] == 1
    assert '"quality"' in str(ev["hint"])
    assert "isn't in this file" in res.stderr


def test_cli_delimiter_flag_is_used(no_env: Path) -> None:
    # Forcing a comma on the semicolon file reads one column -> not_csv (the flag reached the reader).
    res = runner.invoke(
        cli.app,
        ["run", str(FIX / "semicolon.csv"), "--target", "quality", "--delimiter", ",", "--events-stdout"],
    )
    assert res.exit_code == 2
    assert _events(res.stdout)[-1]["code"] == "not_csv"
    # With the right flags the data checks pass and the run gets as far as the (absent) LLM providers.
    res = runner.invoke(
        cli.app,
        ["run", str(FIX / "decimal_comma.csv"), "--target", "Klasse", "--delimiter", ";", "--decimal", ","]
        + ["--encoding", "utf-8", "--events-stdout", "--out", str(no_env)],
    )
    assert res.exit_code == 2
    assert _events(res.stdout)[-1]["code"] == "llm_unavailable"


def test_cli_rejects_unknown_format_flags(no_env: Path) -> None:
    res = runner.invoke(
        cli.app, ["run", str(FIX / "semicolon.csv"), "--target", "quality", "--delimiter", "x"]
    )
    assert res.exit_code == 2 and "delimiter" in res.output


def test_cli_too_few_rows(no_env: Path, tmp_path: Path) -> None:
    p = tmp_path / "tiny.csv"
    p.write_text("a;y\n" + "".join(f"{i};{i % 2}\n" for i in range(6)))
    res = runner.invoke(cli.app, ["run", str(p), "--target", "y", "--events-stdout"])
    assert res.exit_code == 2
    assert _events(res.stdout)[-1]["code"] == "too_few_rows"
