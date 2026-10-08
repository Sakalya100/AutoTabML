"""Request validation and message classification, ported from the web client's shared libs (upload.ts,
chat-input.ts). The browser runs the same checks for instant feedback; these are the authoritative ones."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_EXPERIMENTS_PUBLIC = 10
DEFAULT_EXPERIMENTS = 10
MIN_DATA_ROWS = 20
MAX_DESCRIPTION = 2000
MAX_URL_LENGTH = 2048
ENGINE_METRICS = ("roc_auc", "log_loss", "accuracy", "f1_macro", "rmse", "mae", "r2")
MAX_STEER_CHARS = 300
MAX_MESSAGE_CHARS = 2000


class Invalid(ValueError):
    def __init__(self, field: str, error: str) -> None:
        super().__init__(error)
        self.field = field
        self.error = error


@dataclass(frozen=True)
class RunOptions:
    target: str
    goal: str
    metric: str | None
    max_experiments: int


def validate_run_options(
    *, target: str, goal: str, metric: str | None, max_experiments: object, columns: list[str] | None = None
) -> RunOptions:
    t = (target or "").strip()
    if not t:
        raise Invalid("target", "Pick the column to predict.")
    if len(t) > 200 or re.search(r"[\r\n\x00]", t):
        raise Invalid("target", "That column name is not valid.")
    if columns is not None and t not in columns:
        raise Invalid("target", f'Column "{t}" is not in the CSV header.')
    try:
        n = max_experiments if isinstance(max_experiments, int) else float(str(max_experiments))
    except ValueError:
        n = -1
    if isinstance(n, bool) or not float(n).is_integer() or not 1 <= n <= MAX_EXPERIMENTS_PUBLIC:
        raise Invalid("maxExperiments", f"Experiments must be a whole number from 1 to {MAX_EXPERIMENTS_PUBLIC}.")
    g = (goal or "").strip()
    if len(g) > MAX_DESCRIPTION:
        raise Invalid("goal", f"Keep the sentence under {MAX_DESCRIPTION} characters.")
    m = (metric or "").strip()
    if m and m not in ENGINE_METRICS:
        raise Invalid("metric", "Choose one of the listed metrics.")
    return RunOptions(t, g, m or None, int(n))


def validate_url(raw: str) -> str:
    """A public link: https only, no credentials. The SSRF checks happen separately (and again in the engine)."""
    v = (raw or "").strip()
    if not v:
        raise Invalid("url", "Paste a link to a CSV file.")
    if len(v) > MAX_URL_LENGTH:
        raise Invalid("url", "That link is too long.")
    try:
        parts = urlsplit(v)
        _ = parts.port
    except ValueError:
        raise Invalid("url", "That isn't a valid link. Paste the full address, starting with https://") from None
    if not parts.scheme or not parts.netloc:
        raise Invalid("url", "That isn't a valid link. Paste the full address, starting with https://")
    if parts.scheme.lower() != "https":
        raise Invalid("url", "Only https:// links are supported.")
    if parts.username is not None or parts.password is not None:
        raise Invalid("url", "Links with a user name or password in them aren't allowed.")
    path = parts.path or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, parts.fragment))


def split_csv_line(line: str, delimiter: str = ",") -> list[str]:
    out: list[str] = []
    cur, in_quotes, i = "", False, 0
    while i < len(line):
        ch = line[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < len(line) and line[i + 1] == '"':
                    cur += '"'
                    i += 1
                else:
                    in_quotes = False
            else:
                cur += ch
        elif ch == '"' and cur.strip() == "":
            in_quotes, cur = True, ""
        elif ch == delimiter:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
        i += 1
    out.append(cur.strip())
    return out


def validate_upload(*, file_name: str, data: bytes) -> list[str]:
    """An uploaded CSV file; returns its header columns."""
    if not file_name or not file_name.lower().endswith(".csv"):
        raise Invalid("file", "Upload a .csv file.")
    if not data:
        raise Invalid("file", "The file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise Invalid(
            "file",
            f"The file is {len(data) / 1048576:.1f} MB; the limit for uploads is 5 MB. "
            "Paste a link instead (up to 50 MB).",
        )
    if b"\x00" in data[:4096]:
        raise Invalid("file", "This doesn't look like a text CSV file.")
    text = data.decode("utf-8", errors="replace").removeprefix("﻿")
    lines = re.split(r"\r?\n", text)
    header = lines.pop(0) if lines else ""
    columns = split_csv_line(header) if header.strip() else []
    if len(columns) < 2:
        raise Invalid("file", "The CSV needs a header row with at least two columns.")
    if any(c == "" for c in columns):
        raise Invalid("file", "Every column in the header needs a name.")
    seen: set[str] = set()
    for c in columns:
        if c in seen:
            raise Invalid("file", f'Column "{c}" appears twice in the header.')
        seen.add(c)
    rows = sum(1 for ln in lines if ln.strip() != "")
    if rows < MIN_DATA_ROWS:
        raise Invalid("file", f"Need at least {MIN_DATA_ROWS} data rows; found {rows}.")
    return columns


# ------------------------------------------------------------------------------------------------------ messages

Intent = Literal["control", "steer", "chat"]

_STOP_PHRASES = {
    "stop",
    "stop now",
    "stop it",
    "stop the run",
    "stop here",
    "please stop",
    "stop please",
    "halt",
    "enough",
    "thats enough",
    "that is enough",
    "wrap up",
    "wrap it up",
    "finish now",
    "end the run",
}


def normalize_command(text: str) -> str:
    t = re.sub(r"[’']", "", text.lower())
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def is_stop_command(text: str) -> bool:
    return normalize_command(text) in _STOP_PHRASES


def classify_message(text: str, *, run_active: bool) -> tuple[Intent, str]:
    t = re.sub(r"\s+", " ", text).strip()
    if not run_active:
        return "chat", t[:MAX_MESSAGE_CHARS]
    if is_stop_command(t):
        return "control", "stop"
    return "steer", t[:MAX_STEER_CHARS]


def session_title(*, goal: str | None, target: str, file_name: str | None = None) -> str:
    """ "predict churn" -> "Predicting churn"; otherwise "Predicting <target>" (a session's default title)."""
    g = re.sub(r"[.!?]+$", "", re.sub(r"\s+", " ", goal or "").strip())
    m = re.match(
        r"^(?:i want to |we want to |please )?(predict|forecast|estimate|classify|detect)\s+(.{2,60})$", g, re.I
    )
    if m:
        return f"Predicting {m.group(2)}"[:80]
    if g and len(g) <= 48 and not re.match(r"^https?:", g, re.I):
        return g[0].upper() + g[1:]
    t = re.sub(r"[_-]+", " ", target).strip() or target
    return f"Predicting {t}"[:80]


def file_name_from_url(url: str) -> str:
    from urllib.parse import unquote

    parts = urlsplit(url)
    segs = [s for s in parts.path.split("/") if s]
    name = unquote(segs[-1]) if segs else ""
    if not name or name in ("export", "uc"):
        name = parts.hostname or ""
    return name[:200]
