from __future__ import annotations

import math

from autotinker.evolve.stopping import HistoryPoint, StopRule, fit_saturation


def history(curve: list[float], se: float, radical_tail: int = 0) -> list[HistoryPoint]:
    out = []
    prev = None
    for i, v in enumerate(curve):
        keep = prev is None or v > prev
        out.append(
            HistoryPoint(
                exp_id=f"e{i:03d}",
                status="keep" if keep else "discard",
                radical=False,
                best_mean=v,
                best_se=se,
                keep_gain=None if prev is None or not keep else v - prev,
            )
        )
        prev = v
    for j in range(radical_tail):
        out.append(HistoryPoint(f"r{j}", "discard", True, curve[-1], se))
    return out


def saturating(n: int) -> list[float]:
    best, out = -1.0, []
    for t in range(n):
        v = round(0.9 - 0.2 * math.exp(-0.6 * t), 4)
        best = max(best, v)
        out.append(best)
    return out


def test_fires_on_saturating_curve() -> None:
    h = history(saturating(25), se=0.005, radical_tail=4)
    d = StopRule(min_experiments=10, max_experiments=None).check(h)
    assert d.stop and d.reason == "ceiling", d.report
    assert set(d.report) == {"noise_floor", "saturation", "exploration"}
    assert "stopped at experiment" in d.summary and "radical" in d.summary


def test_not_on_steadily_rising_curve() -> None:
    h = history([0.5 + 0.01 * t for t in range(25)], se=0.002, radical_tail=4)
    d = StopRule(min_experiments=10, max_experiments=None).check(h)
    assert not d.stop
    assert not d.report["saturation"]["fired"]
    assert not d.report["noise_floor"]["fired"]


def test_requires_radical_exploration() -> None:
    d = StopRule(min_experiments=10, max_experiments=None).check(
        history(saturating(25), se=0.005, radical_tail=1)
    )
    assert not d.stop and not d.report["exploration"]["fired"]


def test_respects_min_experiments() -> None:
    h = history([0.8] * 4, se=0.01, radical_tail=4)  # flat: everything fires, only 8 points
    assert not StopRule(min_experiments=10, max_experiments=None).check(h).stop
    assert StopRule(min_experiments=8, max_experiments=None).check(h).stop


def test_budgets() -> None:
    h = history([0.5 + 0.01 * t for t in range(5)], se=0.002)
    assert StopRule(max_experiments=5).check(h).reason == "max_experiments"
    assert StopRule(max_experiments=None, max_cost_usd=1.0).check(h, cost_usd=1.5).reason == "max_cost"
    assert StopRule(max_experiments=None, max_time_s=10).check(h, elapsed_s=11).reason == "max_time"
    assert not StopRule(max_experiments=None).check(h).stop
    # n_experiments (incl. crashes) counts for the experiment budget
    assert StopRule(max_experiments=8).check(h, n_experiments=8).reason == "max_experiments"


def test_until_budget_ignores_ceiling() -> None:
    h = history(saturating(25), se=0.005, radical_tail=4)
    assert not StopRule(until="budget", max_experiments=None).check(h).stop


def test_external_reference() -> None:
    h = history(saturating(25), se=0.005, radical_tail=4)
    assert not StopRule(max_experiments=None, external_ref=0.95, external_eps=0.01).check(h).stop
    d = StopRule(max_experiments=None, external_ref=0.905, external_eps=0.01).check(h)
    assert d.stop and d.report["external_ref"]["fired"]


def test_fit_saturation_fallbacks() -> None:
    assert fit_saturation([0.5, 0.5, 0.5])["remaining"] == 0.0
    short = fit_saturation([0.5, 0.6, 0.65])
    assert short["method"].startswith("fallback") and short["remaining"] > 0
    assert fit_saturation([])["remaining"] == math.inf
    good = fit_saturation(saturating(15))
    assert good["method"] == "a - b*exp(-c*t)" and good["remaining"] < 0.01
