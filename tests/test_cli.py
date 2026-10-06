from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from autotinker.cli import app
from autotinker.obs.events import parse_event

DATA = Path(__file__).resolve().parents[1] / "examples" / "data" / "iris_na_classification.csv"

try:
    import autotinker.harness as _h

    HAVE_HARNESS = hasattr(_h, "Harness")
except ImportError:
    HAVE_HARNESS = False

runner = CliRunner()


def test_help_lists_commands() -> None:
    res = runner.invoke(app, ["--help"])
    assert res.exit_code == 0
    for cmd in ("run", "evolve", "replay", "schema"):
        assert cmd in res.output


def test_schema(tmp_path: Path) -> None:
    res = runner.invoke(app, ["schema", str(tmp_path)])
    assert res.exit_code == 0, res.output
    assert json.loads((tmp_path / "events.schema.json").read_text())
    assert json.loads((tmp_path / "run_record.schema.json").read_text())


def test_replay_of_fake_run(tmp_path: Path) -> None:
    from autotinker.agent.heuristic import HeuristicProposer
    from autotinker.evolve.loop import evolve
    from autotinker.evolve.stopping import StopRule
    from tests.conftest import FakeHarness

    evolve(
        FakeHarness(),
        HeuristicProposer(),
        stop_rule=StopRule(max_experiments=5),
        run_dir=tmp_path,
        starter_code="def build_pipeline(profile):\n    return 0\n",
    )
    res = runner.invoke(app, ["replay", str(tmp_path / "run.json")])
    assert res.exit_code == 0, res.output
    assert "e004" in res.output and "max_experiments" in res.output and "optimism gap" in res.output


@pytest.mark.skipif(not HAVE_HARNESS, reason="harness not available")
@pytest.mark.timeout(600)
def test_evolve_events_stdout_is_pure_jsonl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    res = runner.invoke(
        app,
        [
            "evolve",
            str(DATA),
            "--target",
            "variety",
            "--max-experiments",
            "3",
            "--out",
            str(tmp_path),
            "--events-stdout",
        ],
    )
    assert res.exit_code == 0, res.output
    lines = [ln for ln in res.stdout.splitlines() if ln.strip()]
    events = [parse_event(ln) for ln in lines]  # every stdout line must be an event
    assert events[0].type == "run_started" and events[-1].type == "run_finished"
    assert [e.seq for e in events] == list(range(1, len(events) + 1))
    assert events[0].proposer == "heuristic"  # no key -> heuristic, notice on stderr
    assert "heuristic" in res.stderr
    run_json = next(tmp_path.glob("*/run.json"))
    assert json.loads(run_json.read_text())["final"]["test_score"] is not None
