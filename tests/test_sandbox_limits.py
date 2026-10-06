"""Sandbox isolation tests. These run real worker subprocesses (no mocks).

`Harness._sandbox` bypasses the static check on purpose, so we can prove the runtime defences
(network block, env scrub) hold even if a forbidden import slipped past the AST check.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from autotinker.contracts import TaskSpec
from autotinker.data import load_source
from autotinker.harness import Harness

DATA = Path(__file__).resolve().parent.parent / "examples" / "data"
B = "\ndef build_pipeline(profile):\n"


@pytest.fixture(scope="module")
def h(tmp_path_factory: pytest.TempPathFactory) -> Harness:
    df = load_source(DATA / "iris_classification.csv")
    task = TaskSpec(
        target="variety", cv_folds=2, cv_repeats=1, experiment_timeout_s=3.0, experiment_memory_mb=300
    )
    return Harness(df, task, tmp_path_factory.mktemp("sbx"))


def test_infinite_loop_is_killed_within_budget(h: Harness) -> None:
    t0 = time.monotonic()
    r = h.evaluate(B + "    while True:\n        pass\n", "loop")
    elapsed = time.monotonic() - t0
    assert not r.ok and r.error_kind == "timeout"
    assert elapsed < 3.0 + 2.0
    assert r.error_tail and "TIMEOUT" in r.error_tail


def test_huge_allocation_is_killed_as_memory(h: Harness) -> None:
    code = (
        "import numpy as np"
        + B
        + "    blocks = [np.ones(50_000_000) for _ in range(20)]\n    return blocks\n"
    )
    t0 = time.monotonic()
    r = h.evaluate(code, "mem")
    assert not r.ok and r.error_kind == "memory", r.error_tail
    assert time.monotonic() - t0 < 3.0  # killed by the memory watchdog, not the timeout
    # macOS: the parent RSS watchdog fires ("MEMORY: killed ..."); Linux: RLIMIT_DATA -> MemoryError.
    assert r.error_tail and "memory" in r.error_tail.lower()


def test_network_blocked_in_worker(h: Harness) -> None:
    code = "import socket" + B + "    socket.create_connection(('example.com', 80), timeout=2)\n"
    assert h.evaluate(code, "net-static").error_kind == "static_check"
    r = h._sandbox(code, "cv", "net")
    assert not r.ok and r.error_kind == "runtime"
    assert r.error_tail and "network access is blocked" in r.error_tail


def test_env_is_scrubbed(h: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-leak")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-leak")
    code = (
        "import os"
        + B
        + "    keys = [k for k in os.environ if 'KEY' in k or 'TOKEN' in k or 'SECRET' in k]\n"
        "    val = os.environ.get('ANTHROPIC_API_KEY')\n"
        "    raise RuntimeError('ENVCHECK keys=' + repr(keys) + ' val=' + repr(val))\n"
    )
    r = h._sandbox(code, "cv", "env")
    assert r.error_tail and "ENVCHECK keys=[] val=None" in r.error_tail
    assert "should-not-leak" not in r.error_tail


def test_cwd_is_fresh_temp_dir(h: Harness) -> None:
    code = "import os" + B + "    raise RuntimeError('CWD=' + os.getcwd() + ' LS=' + repr(os.listdir('.')))\n"
    r = h._sandbox(code, "cv", "cwd")
    assert r.error_tail and "autotinker-sbx-" in r.error_tail and "LS=[]" in r.error_tail
