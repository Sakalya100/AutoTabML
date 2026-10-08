"""Live control of a running agentic loop: steering messages and a graceful stop.

The web runner writes JSONL commands to the engine (stdin or a FIFO); a daemon thread reads them into a
thread-safe queue and the loop drains that queue on its own (main) thread:

    {"type": "steer", "text": "prefer simple linear models"}
    {"type": "stop"}

Reading never blocks the run, and the daemon thread never keeps the process alive.
"""

from __future__ import annotations

import json
import queue
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Literal

MAX_TEXT = 300


@dataclass(frozen=True)
class ControlCommand:
    type: Literal["steer", "stop"]
    text: str = ""


def parse_command(line: str) -> ControlCommand | None:
    """One JSONL line -> a command, or None for blank/invalid lines."""
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    typ = obj.get("type")
    if typ == "stop":
        return ControlCommand("stop")
    if typ == "steer":
        text = obj.get("text")
        if not isinstance(text, str) or not text.strip():
            return None
        return ControlCommand("steer", " ".join(text.split())[:MAX_TEXT])
    return None


class ControlChannel:
    """Thread-safe command queue, optionally fed by a background reader thread."""

    def __init__(self) -> None:
        self._q: queue.Queue[ControlCommand] = queue.Queue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ---------------------------------------------------------------- producers

    def push(self, cmd: ControlCommand) -> None:
        if cmd.type == "stop":
            self._stop.set()
        self._q.put(cmd)

    def feed_line(self, line: str) -> None:
        cmd = parse_command(line)
        if cmd is None:
            if line.strip():
                print(f"[autotinker] ignored control line: {line.strip()[:120]!r}", file=sys.stderr)
            return
        self.push(cmd)

    def read_stream(self, stream: IO[str]) -> None:
        """Blocking: read lines until EOF (runs in the reader thread)."""
        try:
            for line in stream:
                self.feed_line(line)
        except (OSError, ValueError) as exc:  # closed stream at shutdown
            print(f"[autotinker] control reader stopped: {exc}", file=sys.stderr)

    def _start(self, target: object, name: str) -> ControlChannel:
        t = threading.Thread(target=target, name=name, daemon=True)  # type: ignore[arg-type]
        self._thread = t
        t.start()
        return self

    @classmethod
    def from_stream(cls, stream: IO[str]) -> ControlChannel:
        ch = cls()
        return ch._start(lambda: ch.read_stream(stream), "autotinker-control")

    @classmethod
    def from_stdin(cls) -> ControlChannel:
        ch = cls()
        stdin = sys.stdin
        if stdin is None or stdin.isatty():
            return ch  # interactive terminal: never read the keyboard as commands
        return ch._start(lambda: ch.read_stream(stdin), "autotinker-control-stdin")

    @classmethod
    def from_fifo(cls, path: str | Path) -> ControlChannel:
        ch = cls()

        def run() -> None:
            # open() of a FIFO blocks until a writer appears: do it here, not on the main thread. Reopen after
            # EOF so a writer may connect more than once.
            while True:
                try:
                    with open(path, encoding="utf-8") as f:
                        ch.read_stream(f)
                except OSError as exc:
                    print(f"[autotinker] control fifo unavailable: {exc}", file=sys.stderr)
                    return

        return ch._start(run, "autotinker-control-fifo")

    # ---------------------------------------------------------------- consumer

    def drain(self) -> list[ControlCommand]:
        out: list[ControlCommand] = []
        while True:
            try:
                out.append(self._q.get_nowait())
            except queue.Empty:
                return out

    @property
    def stop_requested(self) -> bool:
        return self._stop.is_set()
