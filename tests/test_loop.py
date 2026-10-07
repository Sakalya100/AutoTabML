from __future__ import annotations

import json
from pathlib import Path

from autotinker.agent.heuristic import HeuristicProposer
from autotinker.agent.llm import ScriptedLLM
from autotinker.agent.proposer import LLMProposer
from autotinker.contracts import Decision
from autotinker.evolve.gate import NaiveGate, StatGate
from autotinker.evolve.loop import count_loc, evolve, run_single
from autotinker.evolve.stopping import StopRule
from autotinker.obs.events import parse_event
from autotinker.obs.record import RunRecord
from tests.conftest import FakeHarness

STARTER = "def build_pipeline(profile):\n    return 'starter'  # fake-score: 0.50\n"


def proposal(
    title: str,
    score: float | None,
    *,
    crash: bool = False,
    radical: bool = False,
    cat: str = "hyperparameters",
) -> str:
    body = "    return 'x'"
    if crash:
        body += "  # CRASH"
    if score is not None:
        body += f"  # fake-score: {score}"
    code = f"def build_pipeline(profile):\n{body}\n    # {title}\n"
    return json.dumps({"title": title, "rationale": "r", "category": cat, "radical": radical, "code": code})


def repair(score: float) -> str:
    return json.dumps({"code": f"def build_pipeline(profile):\n    return 'fixed'  # fake-score: {score}\n"})


def test_scripted_evolve_events_and_record(tmp_path: Path) -> None:
    h = FakeHarness()
    llm = ScriptedLLM(
        [
            proposal("better model", 0.60),  # e001 keep
            proposal("noise tweak", 0.6001),  # e002 discard (below 0.5 SE)
            proposal("broken idea", None, crash=True),  # e003 crash ...
            repair(0.40),  # ... repaired, then discarded (worse)
            proposal("always broken", None, crash=True),  # e004 crash after 3 failed repairs
            json.dumps({"code": "def build_pipeline(profile):\n    return 1  # CRASH\n"}),
            json.dumps({"code": "def build_pipeline(profile):\n    return 2  # CRASH\n"}),
            json.dumps({"code": "def build_pipeline(profile):\n    return 3  # CRASH\n"}),
            proposal("ensemble", 0.70, radical=True, cat="ensembling"),  # e005 keep
        ]
    )
    seen: list[object] = []
    rec = evolve(
        h,
        LLMProposer(llm),
        gate=StatGate(),
        stop_rule=StopRule(max_experiments=6, min_experiments=100),
        on_event=seen.append,
        run_dir=tmp_path,
        run_id="r1",
        starter_code=STARTER,
        contract_doc="CONTRACT",
    )
    assert not llm.queue  # every scripted reply consumed
    statuses = [e.status for e in rec.experiments]
    assert statuses == [
        Decision.keep,
        Decision.keep,
        Decision.discard,
        Decision.discard,
        Decision.crash,
        Decision.keep,
    ]
    assert rec.experiments[3].repair_attempts == 1 and rec.experiments[4].repair_attempts == 3
    assert rec.best_exp_id == "e005" and rec.final is not None
    assert rec.final.optimism_gap == rec.final.select_score - rec.final.test_score
    assert h.test_calls == 1
    assert rec.stop and rec.stop["reason"] == "max_experiments"
    assert rec.experiments[1].diff.startswith("--- e000/solution.py")
    assert rec.experiments[5].parent_id == "e001"
    assert rec.total_cost_usd > 0 and rec.total_input_tokens == 100 * 9
    assert rec.experiments[0].loc == count_loc(STARTER)

    types = [e.type for e in seen]  # type: ignore[attr-defined]
    assert types[0] == "run_started" and types[-2:] == ["stopped", "run_finished"]
    seqs = [e.seq for e in seen]  # type: ignore[attr-defined]
    assert seqs == list(range(1, len(seen) + 1))
    # per-experiment ordering for e004: started, llm_call(propose), 4 sandboxes interleaved with repairs
    e4 = [e.type for e in seen if getattr(e, "exp_id", None) == "e004"]  # type: ignore[attr-defined]
    assert e4 == ["experiment_started", "llm_call"] + ["sandbox_finished", "llm_call"] * 3 + [
        "sandbox_finished",
        "decision",
    ]
    assert "experiment_scored" not in e4

    # artifacts on disk round-trip
    on_disk = RunRecord.model_validate_json((tmp_path / "run.json").read_text())
    assert on_disk.final == rec.final
    lines = (tmp_path / "events.jsonl").read_text().splitlines()
    assert [parse_event(ln).seq for ln in lines] == seqs
    assert len((tmp_path / "ledger.jsonl").read_text().splitlines()) == 6
    assert "fake-score: 0.7" in (tmp_path / "best_solution.py").read_text()


def test_proposal_failures_abort_cleanly(tmp_path: Path) -> None:
    h = FakeHarness()
    rec = evolve(
        h,
        LLMProposer(ScriptedLLM(["x"] * 6)),
        stop_rule=StopRule(max_experiments=20),
        run_dir=tmp_path,
        starter_code=STARTER,
    )
    assert rec.stop and rec.stop["reason"] == "proposer_failure" and "failed 3 times" in rec.stop["summary"]
    assert [e.status for e in rec.experiments][1:] == [Decision.crash] * 3
    assert h.test_calls == 1 and rec.best_exp_id == "e000"


def test_heuristic_evolve_reaches_ceiling() -> None:
    h = FakeHarness()
    rec = evolve(
        h,
        HeuristicProposer(seed=0),
        stop_rule=StopRule(max_experiments=60, min_experiments=8, radical_k=3),
        starter_code=STARTER,
    )
    assert rec.proposer == "heuristic"
    assert rec.stop and rec.stop["reason"] == "ceiling", rec.stop
    assert len(rec.experiments) < 60


def test_naive_gate_keeps_noise() -> None:
    h = FakeHarness()
    llm = ScriptedLLM([proposal("tiny", 0.5001), proposal("tiny2", 0.5002)])
    rec = evolve(
        h, LLMProposer(llm), gate=NaiveGate(), stop_rule=StopRule(max_experiments=3), starter_code=STARTER
    )
    assert [e.status for e in rec.experiments] == [Decision.keep] * 3


def test_run_single_with_repair_and_fallback(tmp_path: Path) -> None:
    h = FakeHarness()
    llm = ScriptedLLM([proposal("draft", None, crash=True), repair(0.8)])
    rec = run_single(h, LLMProposer(llm), run_dir=tmp_path, starter_code=STARTER)
    assert rec.mode == "run" and len(rec.experiments) == 1
    assert rec.experiments[0].status == Decision.keep and rec.experiments[0].repair_attempts == 1
    assert rec.final and abs(rec.final.select_score - 0.8) < 1e-9

    h2 = FakeHarness()
    bad = [proposal("draft", None, crash=True)] + [
        json.dumps({"code": "def build_pipeline(p):\n    return 0 # CRASH\n"})
    ] * 3
    rec2 = run_single(h2, LLMProposer(ScriptedLLM(bad)), starter_code=STARTER)
    assert [e.status for e in rec2.experiments] == [Decision.crash, Decision.keep]
    assert rec2.best_exp_id == "e001" and h2.test_calls == 1


def test_run_predict_and_export(tmp_path: Path) -> None:
    import numpy as np
    import pandas as pd

    from autotinker.api import Run

    rng = np.random.default_rng(0)
    n = 90
    df = pd.DataFrame(
        {
            "a": rng.normal(size=n),
            "b": rng.normal(size=n),
            "c": rng.choice(["p", "q", "r"], size=n),
        }
    )
    df["y"] = np.where(df["a"] > 0.5, "z", np.where(df["a"] < -0.5, "x", "y"))
    df.loc[::7, "a"] = np.nan
    rec = evolve(FakeHarness(), HeuristicProposer(), stop_rule=StopRule(max_experiments=4), run_dir=tmp_path)
    run = Run(rec, tmp_path, df)
    pred = run.predict(df.drop(columns=["y"]))
    assert set(pred.unique()) <= {"x", "y", "z"} and len(pred) == n
    out = run.export(tmp_path / "export")
    names = {p.name for p in out.iterdir()}
    assert {"solution.py", "train.py", "README.md", "requirements.txt", "run.json", "profile.json"} <= names
    assert len(run.leaderboard) == 4 and run.test_score is not None


def test_auth_error_stops_immediately(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from autotinker.agent.llm import LLMAuthError, is_fatal_llm_error
    from autotinker.agent.proposer import ProposalFailed

    try:
        try:
            raise LLMAuthError("HTTP 401")
        except LLMAuthError as inner:
            raise ProposalFailed("draft failed", []) from inner
    except ProposalFailed as outer:
        assert is_fatal_llm_error(outer)
    assert not is_fatal_llm_error(RuntimeError("boom"))
