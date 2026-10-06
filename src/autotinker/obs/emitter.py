"""EventEmitter: assigns a strictly increasing `seq` per run and fans events out to sinks.

Sinks: in-process callbacks, an append-only JSONL file (events.jsonl) and, optionally, stdout as JSONL
(used by `autotinker evolve --events-stdout`, which the web app's local runner parses line by line).
"""

from __future__ import annotations

import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import IO, Any

from autotinker.obs.events import Event

EventCallback = Callable[[Any], None]


class EventEmitter:
    def __init__(
        self,
        run_id: str,
        *,
        jsonl_path: Path | None = None,
        callbacks: list[EventCallback] | None = None,
        stdout: bool = False,
        stdout_stream: IO[str] | None = None,
    ) -> None:
        self.run_id = run_id
        self.callbacks: list[EventCallback] = list(callbacks or [])
        self._seq = 0
        self._lock = threading.Lock()
        self._file: IO[str] | None = None
        if jsonl_path is not None:
            jsonl_path.parent.mkdir(parents=True, exist_ok=True)
            self._file = jsonl_path.open("a", encoding="utf-8")
        self._stdout: IO[str] | None = (stdout_stream or sys.stdout) if stdout else None
        self.history: list[Event] = []

    def emit(self, event: Event) -> Event:
        with self._lock:
            self._seq += 1
            event.seq = self._seq
            event.run_id = self.run_id
            line = event.model_dump_json()
            if self._file is not None:
                self._file.write(line + "\n")
                self._file.flush()
            if self._stdout is not None:
                self._stdout.write(line + "\n")
                self._stdout.flush()
            self.history.append(event)
        for cb in self.callbacks:
            try:
                cb(event)
            except Exception as exc:  # a broken consumer must never kill the run
                print(f"[autotinker] on_event callback raised {exc!r}", file=sys.stderr)
        return event

    @property
    def seq(self) -> int:
        return self._seq

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None

    def __enter__(self) -> EventEmitter:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
