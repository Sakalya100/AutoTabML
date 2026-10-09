"""CSV/TSV sniffing, parsing and column profiling for the link preview.

A port of web/src/lib/ingest/csv.ts, which the browser still uses for uploaded files and when the user picks another
target column; both must produce the same `ColumnStats`, so keep them in step (tests/test_preview.py pins the
behaviour). Handles a UTF-8 BOM, CRLF, quoted fields (with "" escapes and embedded newlines) and , ; TAB | delimiters.
"""

from __future__ import annotations

import math
import re
from typing import Any

ColumnStats = dict[str, Any]

MISSING = {"", "na", "n/a", "nan", "null", "none", "?", "-", "--", "#n/a"}
_NUM_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$", re.ASCII)
_BOOL = {"true", "false", "yes", "no", "t", "f", "y", "n"}
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?|^\d{1,2}/\d{1,2}/\d{2,4}$", re.ASCII)
_ID_NAME = re.compile(
    r"^(id|index|uuid|guid|key|row ?id|unnamed: ?0|passengerid|customerid|customer ?id)$|(^|[_\s.-])id$|^id[_\s.-]",
    re.IGNORECASE,
)


def is_missing(v: str | None) -> bool:
    return v is None or v.strip().lower() in MISSING


def strip_bom(s: str) -> str:
    return s[1:] if s.startswith("﻿") else s


def _count_outside_quotes(line: str, d: str) -> int:
    n, q = 0, False
    for ch in line:
        if ch == '"':
            q = not q
        elif not q and ch == d:
            n += 1
    return n


def sniff_delimiter(text: str) -> str:
    """The delimiter that appears the same (non-zero) number of times on the most of the first lines."""
    lines = [ln for ln in re.split(r"\r?\n", strip_bom(text)) if ln.strip() != ""][:12]
    best, best_score = ",", -1
    for d in (",", "\t", ";", "|"):
        counts = [_count_outside_quotes(ln, d) for ln in lines]
        head = counts[0] if counts else 0
        if head == 0:
            continue
        score = sum(1 for c in counts if c == head) * 1000 + head
        if score > best_score:
            best, best_score = d, score
    return best


def parse_delimited(
    text: str, delimiter: str, *, max_records: float = math.inf, partial: bool = False
) -> list[list[str]]:
    """Records of delimited text. `partial`: the text is a prefix of the file, so a last unterminated record is
    dropped. Stops after `max_records` records (header included)."""
    src = strip_bom(text)
    out: list[list[str]] = []
    row: list[str] = []
    field: list[str] = []
    in_quotes = field_started = False
    complete = True
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        complete = False
        if in_quotes:
            if ch == '"':
                if i + 1 < n and src[i + 1] == '"':
                    field.append('"')
                    i += 1
                else:
                    in_quotes = False
            else:
                field.append(ch)
            i += 1
            continue
        if ch == '"' and not field_started:
            in_quotes = field_started = True
        elif ch == delimiter:
            row.append("".join(field).strip())
            field, field_started = [], False
        elif ch in "\n\r":
            if ch == "\r" and i + 1 < n and src[i + 1] == "\n":
                i += 1
            row.append("".join(field).strip())
            if not (len(row) == 1 and row[0] == ""):
                out.append(row)
            row, field, field_started, complete = [], [], False, True
            if len(out) >= max_records:
                return out
        else:
            field.append(ch)
            if ch not in " \t":
                field_started = True
        i += 1
    if not complete and not partial and not in_quotes:
        row.append("".join(field).strip())
        if not (len(row) == 1 and row[0] == ""):
            out.append(row)
    return out if max_records == math.inf else out[: int(max_records)]


def _num(v: str) -> float:
    return float(v.replace(",", ""))


def _clean(x: float) -> int | float | None:
    if not math.isfinite(x):
        return None
    return int(x) if x.is_integer() else x


def profile_column(name: str, values: list[str]) -> ColumnStats:
    present = [v for v in values if not is_missing(v)]
    uniq = set(present)
    base: ColumnStats = {
        "name": name,
        "count": len(present),
        "missing": len(values) - len(present),
        "unique": len(uniq),
    }
    if 2 <= len(uniq) <= 50:  # class balance for a classification target (rows in the rarest value)
        counts: dict[str, int] = {}
        for v in present:
            counts[v] = counts.get(v, 0) + 1
        base["minCount"] = min(counts.values())
    if not present:
        return {**base, "kind": "empty"}
    if all(_NUM_RE.match(v.replace(",", "")) for v in present):
        nums = [_num(v) for v in present]
        ints = all(math.isfinite(x) and x.is_integer() for x in nums)
        lo, hi = min(nums), max(nums)
        if ints and len(uniq) == 2 and lo == 0 and hi == 1:
            return {**base, "kind": "boolean", "min": _clean(lo), "max": _clean(hi)}
        id_like = ints and bool(_ID_NAME.search(name)) and len(uniq) == len(present) and len(present) >= 10
        kind = "id" if id_like else "integer" if ints else "numeric"
        return {**base, "kind": kind, "min": _clean(lo), "max": _clean(hi)}
    lower = {v.lower() for v in present}
    if len(lower) <= 2 and all(v in _BOOL for v in lower):
        return {**base, "kind": "boolean"}
    if sum(1 for v in present if _DATE_RE.search(v)) >= len(present) * 0.9:
        return {**base, "kind": "datetime"}
    if _ID_NAME.search(name) and len(uniq) >= len(present) * 0.95:
        return {**base, "kind": "id"}
    avg_len = sum(len(v) for v in present) / len(present)
    categorical = len(uniq) <= max(20, len(present) * 0.5) and avg_len < 40
    return {**base, "kind": "categorical" if categorical else "text"}


def parse_table(text: str, *, partial: bool = False, sample_rows: int = 50, stats_rows: int = 5000) -> dict[str, Any]:
    delimiter = sniff_delimiter(text)
    records = parse_delimited(text, delimiter, partial=partial, max_records=stats_rows + 1)
    header = records.pop(0) if records else []
    columns = [c or f"column_{i + 1}" for i, c in enumerate(header)]
    width = len(columns)
    rows = [r[:width] if len(r) >= width else r + [""] * (width - len(r)) for r in records]
    stats = [profile_column(c, [r[j] for r in rows]) for j, c in enumerate(columns)]
    return {
        "delimiter": delimiter,
        "columns": columns,
        "sample": rows[:sample_rows],
        "parsedRows": len(rows),
        "stats": stats,
    }


def looks_like_html(head: str, content_type: str | None) -> bool:
    t = strip_bom(head).lstrip()[:2048].lower()
    if t.startswith(("<!doctype html", "<html")):
        return True
    return "text/html" in (content_type or "").lower() and bool(re.search(r"<(html|!doctype|head|body)\b", t))


_DECIMAL_COMMA = re.compile(r"^[+-]?\d+,\d+$", re.ASCII)
_DECIMAL_POINT = re.compile(r"^[+-]?\d+\.\d+$", re.ASCII)


def sniff_decimal(text: str, delimiter: str) -> str:
    """"," when the first data rows hold unquoted numbers like 7,4 and none like 7.4 (only possible when the delimiter
    isn't a comma); else ".". The engine's rule (src/autotinker/data/csvformat.py sniff_decimal)."""
    if delimiter == ",":
        return "."
    comma = point = 0
    for line in [ln for ln in re.split(r"\r?\n", strip_bom(text)) if ln.strip() != ""][1:12]:
        for field in line.split(delimiter):
            f = field.strip()
            if _DECIMAL_COMMA.match(f):
                comma += 1
            elif _DECIMAL_POINT.match(f):
                point += 1
    return "," if comma > 0 and point == 0 else "."
