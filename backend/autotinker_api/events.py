"""Engine events (JSONL, one object per line, `seq` strictly increasing) and what they change on the run row."""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

Event = dict[str, Any]


def coerce_event(obj: object) -> Event | None:
    """An event dict if `obj` looks like one (integer seq >= 0, string type), else None."""
    if not isinstance(obj, dict):
        return None
    seq, typ = obj.get("seq"), obj.get("type")
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0 or not isinstance(typ, str) or not typ:
        return None
    return obj


def parse_lines(lines: Iterable[str]) -> list[Event]:
    out: list[Event] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            ev = coerce_event(json.loads(line))
        except ValueError:
            continue
        if ev is not None:
            out.append(ev)
    return out


class JsonlDecoder:
    """Incremental JSONL decoder for a byte/text stream; non-event lines go to `on_other`."""

    def __init__(self) -> None:
        self._buf = ""
        self.other: list[str] = []

    def push(self, chunk: str) -> list[Event]:
        self._buf += chunk
        *lines, self._buf = self._buf.split("\n")
        return self._decode(lines)

    def end(self) -> list[Event]:
        rest, self._buf = self._buf, ""
        return self._decode([rest])

    def _decode(self, lines: list[str]) -> list[Event]:
        out: list[Event] = []
        for line in lines:
            if not line.strip():
                continue
            try:
                ev = coerce_event(json.loads(line))
            except ValueError:
                ev = None
            if ev is None:
                self.other.append(line)
                self.other = self.other[-20:]
            else:
                out.append(ev)
        return out


def run_patch_from_events(events: Iterable[Event]) -> dict[str, Any]:
    """What a batch of events changes on the run row: best score so far, final numbers, stop reason, report headline.
    Returns {"best"?: float|None, "summary"?: {...}} (summary is shallow-merged into runs.summary)."""
    patch: dict[str, Any] = {}
    summary: dict[str, Any] = {}
    for ev in events:
        t = ev.get("type")
        if t == "decision":
            _set_best(patch, ev.get("best_cv_mean"))
        elif t == "stopped":
            summary["stop"] = {"reason": ev.get("reason"), "summary": ev.get("summary")}
        elif t == "run_finished":
            _set_best(patch, ev.get("dev_cv_mean"))
            summary["final"] = {
                k: ev.get(k)
                for k in (
                    "best_exp_id",
                    "dev_cv_mean",
                    "select_score",
                    "test_score",
                    "optimism_gap",
                    "n_experiments",
                    "total_cost_usd",
                    "wall_time_s",
                )
            }
        elif t == "report_ready":
            r = ev.get("report") or {}
            if isinstance(r, dict):
                summary["report"] = {"plain": r.get("plain"), "summary": r.get("summary")}
        elif t == "run_started":
            p = ev.get("profile") or {}
            if isinstance(p, dict):
                summary["task"] = {
                    "metric": p.get("metric"),
                    "problem_type": p.get("problem_type"),
                    "n_rows": p.get("n_rows"),
                }
    if summary:
        patch["summary"] = summary
    return patch


def _set_best(patch: dict[str, Any], v: object) -> None:
    if isinstance(v, int | float) and not isinstance(v, bool) and v == v and abs(v) != float("inf"):
        patch["best"] = float(v)
