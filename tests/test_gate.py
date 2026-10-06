from __future__ import annotations

import numpy as np

from autotinker.contracts import CVScore, Decision, ExecResult
from autotinker.evolve.gate import Candidate, NaiveGate, StatGate, naive_gate, paired_one_sided_p


def res(folds: list[float], select: float | None = None, fit: float = 1.0) -> ExecResult:
    a = np.asarray(folds)
    cv = CVScore(mean=float(a.mean()), se=float(a.std(ddof=1) / np.sqrt(a.size)), folds=list(a))
    return ExecResult(
        ok=True, cv=cv, select_score=float(a.mean()) if select is None else select, fit_time_s=fit
    )


RNG = np.random.default_rng(42)
BASE = list(0.80 + RNG.normal(0, 0.02, 10))


def test_real_gain_is_kept() -> None:
    cand = [f + 0.02 + RNG.normal(0, 0.002) for f in BASE]
    d, reason = StatGate()(Candidate(res(cand), 40), Candidate(res(BASE), 40))
    assert d == Decision.keep, reason
    assert "improvement" in reason and "p=" in reason


def test_noise_is_discarded() -> None:
    noise = np.random.default_rng(7).normal(0, 0.01, 10)
    cand = [f + n for f, n in zip(BASE, noise, strict=True)]
    d, reason = StatGate()(Candidate(res(cand), 40), Candidate(res(BASE), 40))
    assert d == Decision.discard, reason


def test_tiny_but_consistent_gain_below_half_se_discarded() -> None:
    cand = [f + 1e-4 for f in BASE]  # p = 0 but far below 0.5 SE
    d, reason = StatGate()(Candidate(res(cand), 40), Candidate(res(BASE), 40))
    assert d == Decision.discard
    assert "below 0.5 SE" in reason


def test_select_disagreement_discards() -> None:
    cand = [f + 0.02 for f in BASE]
    best = res(BASE, select=0.85)
    d, reason = StatGate()(Candidate(res(cand, select=0.70), 40), Candidate(best, 40))
    assert d == Decision.discard
    assert "select" in reason


def test_simplification_kept_on_loc() -> None:
    d, reason = StatGate()(Candidate(res(list(BASE)), 30), Candidate(res(BASE), 40))
    assert d == Decision.keep
    assert reason.startswith("simplification") and "LOC 40->30" in reason


def test_simplification_kept_on_fit_time() -> None:
    d, reason = StatGate()(Candidate(res(list(BASE), fit=0.4), 40), Candidate(res(BASE, fit=1.0), 40))
    assert d == Decision.keep and "fit time" in reason


def test_no_simplification_without_reduction() -> None:
    d, _ = StatGate()(Candidate(res(list(BASE)), 39), Candidate(res(BASE), 40))
    assert d == Decision.discard


def test_paired_p_handles_degenerate_vectors() -> None:
    assert paired_one_sided_p([1, 2, 3], [1, 2, 3]) == 1.0
    assert paired_one_sided_p([2, 3, 4], [1, 2, 3]) == 0.0
    assert paired_one_sided_p([1.0], [0.0]) == 1.0


def test_naive_gate_keeps_any_improvement() -> None:
    cand = [f + 1e-6 for f in BASE]
    assert naive_gate(Candidate(res(cand), 40), Candidate(res(BASE), 40))[0] == Decision.keep
    assert NaiveGate()(Candidate(res(BASE), 40), Candidate(res(cand), 40))[0] == Decision.discard


def test_nadeau_bengio_correction_is_more_conservative() -> None:
    rng = np.random.default_rng(0)
    best = list(rng.normal(0.80, 0.02, 10))
    cand = [b + 0.004 + float(rng.normal(0, 0.006)) for b in best]
    plain = paired_one_sided_p(cand, best)
    corrected = paired_one_sided_p(cand, best, test_train_ratio=0.25)
    assert corrected > plain
