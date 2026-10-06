"""Experiment ledger (append-only ledger.jsonl, the analogue of autoresearch's results.tsv) and the
compact idea memory that goes into prompts so the agent does not repeat ideas it already tried.
"""

from __future__ import annotations

import difflib
import re
from collections import Counter
from pathlib import Path

from autotinker.obs.record import ExperimentRecord

_NORM = re.compile(r"[^a-z0-9.]+")


def normalize_title(title: str) -> str:
    return _NORM.sub(" ", title.lower()).strip()


def similar_titles(a: str, b: str, threshold: float = 0.9) -> bool:
    na, nb = normalize_title(a), normalize_title(b)
    if na == nb:
        return True
    return difflib.SequenceMatcher(None, na, nb).ratio() >= threshold


class Ledger:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self.records: list[ExperimentRecord] = []
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, rec: ExperimentRecord) -> None:
        self.records.append(rec)
        if self.path is not None:
            with self.path.open("a", encoding="utf-8") as f:
                f.write(rec.model_dump_json() + "\n")

    def __len__(self) -> int:
        return len(self.records)

    def is_duplicate(self, title: str) -> bool:
        return any(similar_titles(title, r.idea.title) for r in self.records)

    def summary(self, max_lines: int = 25) -> str:
        """Compact, deduplicated history for the prompt. Never includes code or data."""
        if not self.records:
            return "(no experiments yet)"
        groups: list[tuple[ExperimentRecord, int]] = []
        for rec in self.records:
            for i, (g, cnt) in enumerate(groups):
                if similar_titles(g.idea.title, rec.idea.title):
                    groups[i] = (rec, cnt + 1)  # keep the latest outcome
                    break
            else:
                groups.append((rec, 1))
        lines = []
        for rec, cnt in groups[-max_lines:]:
            score = f"cv {rec.cv.mean:.4f}±{rec.cv.se:.4f}" if rec.cv else f"error {rec.error_kind or '?'}"
            rep = f" (tried {cnt}x)" if cnt > 1 else ""
            rad = " [radical]" if rec.idea.radical else ""
            lines.append(
                f"- {rec.id} {rec.status.value.upper()} {rec.idea.category.value}{rad}: "
                f"{rec.idea.title}{rep} -> {score}"
            )
        counts = Counter(r.status.value for r in self.records)
        cats = Counter(r.idea.category.value for r in self.records if r.status.value == "keep")
        head = (
            f"{len(self.records)} experiments: {counts.get('keep', 0)} kept, "
            f"{counts.get('discard', 0)} discarded, "
            f"{counts.get('crash', 0)} crashed. Kept by category: "
            + (", ".join(f"{k}={v}" for k, v in cats.most_common()) or "none")
        )
        omitted = len(groups) - max_lines
        more = [f"(… {omitted} older distinct ideas omitted)"] if omitted > 0 else []
        return "\n".join([head, *more, *lines])
