"""Delimited-text format detection and parsing, shared by local files, uploads and downloaded links.

The web preview (backend/autotinker_api/preview/csvparse.py and web/src/lib/ingest/csv.ts) detects a
file's delimiter, encoding and decimal mark; when it passes them on (`autotinker run --delimiter ;
--encoding utf-8 --decimal .`) the engine parses with exactly that format. Without them the engine detects
the format itself with the same rules, so the preview and the run agree either way:

* encoding: a UTF-8 BOM -> ``utf-8-sig``; valid UTF-8 -> ``utf-8``; else ``cp1252`` (Windows "ANSI"); else
  ``latin-1`` (which decodes any byte sequence).
* delimiter: of ``,`` TAB ``;`` ``|``, the one that appears the same non-zero number of times (outside
  quotes) on the most of the first 12 non-empty lines (ties go to the higher count) - the preview's
  `sniff_delimiter`.
* decimal: ``,`` only when the delimiter is not a comma, some unquoted fields look like ``7,4`` and none like
  ``7.4``; else ``.``.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

DELIMITERS = (",", "\t", ";", "|")
ENCODINGS = ("utf-8", "utf-8-sig", "cp1252", "latin-1")
DECIMALS = (".", ",")
_DELIMITER_ALIASES = {"tab": "\t", "\\t": "\t", "comma": ",", "semicolon": ";", "pipe": "|"}
_ENCODING_ALIASES = {
    "utf8": "utf-8",
    "utf-8-bom": "utf-8-sig",
    "utf8-sig": "utf-8-sig",
    "windows-1252": "cp1252",
    "latin1": "latin-1",
    "iso-8859-1": "latin-1",
}
_SNIFF_BYTES = 64 * 1024
_SNIFF_LINES = 12
_DECIMAL_COMMA = re.compile(r"^[+-]?\d+,\d+$")
_DECIMAL_POINT = re.compile(r"^[+-]?\d+\.\d+$")


class CsvFormatError(ValueError):
    """An explicit format option is not one we understand."""


@dataclass(frozen=True)
class CsvFormat:
    """How to read a delimited text file. Any field left as None is detected from the file."""

    delimiter: str | None = None
    encoding: str | None = None
    decimal: str | None = None

    def as_dict(self) -> dict[str, str | None]:
        return {"delimiter": self.delimiter, "encoding": self.encoding, "decimal": self.decimal}


def normalise_format(
    delimiter: str | None = None, encoding: str | None = None, decimal: str | None = None
) -> CsvFormat:
    """Validate user-facing spellings ("tab", "utf8", "latin1", ...) into a CsvFormat."""
    d = e = m = None
    if delimiter is not None and delimiter != "":
        d = _DELIMITER_ALIASES.get(delimiter.lower(), delimiter)
        if d not in DELIMITERS:
            raise CsvFormatError(f"delimiter must be one of , ; | tab (got {delimiter!r})")
    if encoding:
        e = _ENCODING_ALIASES.get(encoding.strip().lower(), encoding.strip().lower())
        if e not in ENCODINGS:
            raise CsvFormatError(f"encoding must be one of {', '.join(ENCODINGS)} (got {encoding!r})")
    if decimal:
        m = decimal.strip()
        if m not in DECIMALS:
            raise CsvFormatError(f"decimal must be '.' or ',' (got {decimal!r})")
    return CsvFormat(d, e, m)


# ------------------------------------------------------------------------------------------------- detection


def detect_encoding(data: bytes) -> str:
    if data.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    for enc in ("utf-8", "cp1252"):
        try:
            data.decode(enc)
            return enc
        except UnicodeDecodeError:
            continue
    return "latin-1"


def _count_outside_quotes(line: str, d: str) -> int:
    n, q = 0, False
    for ch in line:
        if ch == '"':
            q = not q
        elif not q and ch == d:
            n += 1
    return n


def _lines(text: str) -> list[str]:
    return [ln for ln in re.split(r"\r?\n", text.removeprefix("﻿")) if ln.strip() != ""][:_SNIFF_LINES]


def sniff_delimiter(text: str) -> str:
    """The delimiter that appears the same (non-zero) number of times on the most of the first lines (the
    preview's rule, csvparse.sniff_delimiter). Defaults to a comma."""
    lines = _lines(text)
    best, best_score = ",", -1
    for d in DELIMITERS:
        counts = [_count_outside_quotes(ln, d) for ln in lines]
        head = counts[0] if counts else 0
        if head == 0:
            continue
        score = sum(1 for c in counts if c == head) * 1000 + head
        if score > best_score:
            best, best_score = d, score
    return best


def _split_unquoted(line: str, d: str) -> list[str]:
    """Fields of one line; quoted fields come back as "" since a quoted "7,4" is text, not a number."""
    out: list[str] = []
    cur: list[str] = []
    q = quoted = False
    for ch in line:
        if ch == '"':
            q, quoted = not q, True
        elif ch == d and not q:
            out.append("" if quoted else "".join(cur).strip())
            cur, quoted = [], False
        else:
            cur.append(ch)
    out.append("" if quoted else "".join(cur).strip())
    return out


def sniff_decimal(text: str, delimiter: str) -> str:
    """``,`` when the data rows hold numbers like ``7,4`` and none like ``7.4`` (only possible for a non-comma
    delimiter); else ``.``."""
    if delimiter == ",":
        return "."
    comma = point = 0
    for line in _lines(text)[1:]:
        for f in _split_unquoted(line, delimiter):
            if _DECIMAL_COMMA.match(f):
                comma += 1
            elif _DECIMAL_POINT.match(f):
                point += 1
    return "," if comma > 0 and point == 0 else "."


def detect_format(data: bytes, given: CsvFormat | None = None) -> CsvFormat:
    """Fill in whatever `given` leaves open by looking at the start of the file."""
    given = given or CsvFormat()
    head = data[:_SNIFF_BYTES]
    encoding = given.encoding or detect_encoding(data)
    if encoding == "utf-8" and data.startswith(b"\xef\xbb\xbf"):
        encoding = "utf-8-sig"  # same decoding, but the BOM must not end up in the first column name
    text = head.decode(encoding, errors="replace")
    delimiter = given.delimiter or sniff_delimiter(text)
    decimal = given.decimal or sniff_decimal(text, delimiter)
    return CsvFormat(delimiter, encoding, decimal)


# --------------------------------------------------------------------------------------------------- reading


def read_delimited(source: bytes | Path, fmt: CsvFormat | None, *, na_values: list[str]) -> pd.DataFrame:
    """Parse delimited text with `fmt` (missing fields detected). Raises pandas' ParserError /
    EmptyDataError / UnicodeDecodeError for the caller to turn into a user-facing error."""
    data = source.read_bytes() if isinstance(source, Path) else source
    f = detect_format(data, fmt)
    try:
        return _read(data, f, na_values)
    except UnicodeDecodeError:
        # The preview reads only the first ~2 MB; a stray non-UTF-8 byte further down falls back to detection.
        fallback = detect_encoding(data)
        if fallback == f.encoding:
            raise
        return _read(data, CsvFormat(f.delimiter, fallback, f.decimal), na_values)


def _read(data: bytes, f: CsvFormat, na_values: list[str]) -> pd.DataFrame:
    assert f.delimiter is not None and f.encoding is not None and f.decimal is not None
    return pd.read_csv(
        io.BytesIO(data),
        sep=f.delimiter,
        encoding=f.encoding,
        decimal=f.decimal,
        na_values=na_values,
        keep_default_na=True,
        skipinitialspace=f.delimiter != "\t",
    )
