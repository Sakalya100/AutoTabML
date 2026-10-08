"""Ceiling detection (ROADMAP §3.4): stop when the remaining gains are indistinguishable from noise.

Signals (all applicable ones must fire, and only after `min_experiments`):
  noise_floor   the last `noise_k` kept gains within the last `noise_window` experiments were each below the
                current best's CV SE (fired when nothing was kept in that window)
  saturation    fit best_so_far(t) ~ a - b*exp(-c*t); predicted remaining gain a - current < SE.
                Falls back to recent-window gain when there are < 6 points or the fit fails.
  exploration   >= `radical_k` radical attempts (model family / ensemble / new approach) since the last keep
  external_ref  best within `external_eps` of an external reference score (only if one is given)

Hard budgets (`max_experiments`, `max_cost_usd`, `max_time_s`) always apply, also with until="budget".
"""

from __future__ import annotations

import math
import warnings
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np

StopReason = Literal[
    "ceiling", "max_experiments", "max_cost", "max_time", "user", "proposer_failure", "max_tokens"
]


@dataclass
class HistoryPoint:
    """One finished experiment as the stop rule sees it (oriented scores)."""

    exp_id: str
    status: str  # keep | discard | crash
    radical: bool
    best_mean: float  # best-so-far CV mean *after* this experiment
    best_se: float  # SE of the best-so-far solution after this experiment
    keep_gain: float | None = None  # gain over the previous best when status == keep (not for baseline)


@dataclass
class StopDecision:
    stop: bool
    reason: StopReason | None
    report: dict[str, Any] = field(default_factory=dict)
    summary: str = ""


def _saturating(t: np.ndarray, a: float, b: float, c: float) -> np.ndarray:
    return a - b * np.exp(-c * t)


def fit_saturation(y: list[float], min_points: int = 6) -> dict[str, Any]:
    """Predict the remaining gain of a best-so-far curve. Never raises."""
    arr = np.asarray(y, dtype=float)
    n = arr.size
    if n == 0:
        return {"remaining": math.inf, "method": "none", "params": None}
    current = float(arr[-1])
    rng = float(arr.max() - arr.min())
    if rng < 1e-12:
        return {"remaining": 0.0, "method": "flat", "params": None}
    window = min(n, 6)

    def fallback(why: str) -> dict[str, Any]:
        recent = float(arr[-1] - arr[-window])
        return {
            "remaining": max(recent, 0.0),
            "method": f"fallback ({why}): gain over last {window}",
            "params": None,
        }

    if n < min_points:
        return fallback(f"{n} < {min_points} points")
    t = np.arange(n, dtype=float)
    try:
        from scipy.optimize import OptimizeWarning, curve_fit

        with warnings.catch_warnings():
            warnings.simplefilter("error", OptimizeWarning)
            warnings.simplefilter("ignore", RuntimeWarning)
            popt, _ = curve_fit(
                _saturating,
                t,
                arr,
                p0=(current + 0.1 * rng, rng, 0.3),
                bounds=([float(arr.min()), 0.0, 1e-4], [float(arr.max()) + 10 * rng, 10 * rng + 1e-9, 5.0]),
                maxfev=5000,
            )
        a, b, c = (float(v) for v in popt)
        if not all(math.isfinite(v) for v in (a, b, c)):
            return fallback("non-finite fit")
        return {"remaining": max(a - current, 0.0), "method": "a - b*exp(-c*t)", "params": [a, b, c]}
    except Exception as exc:  # RuntimeError (no convergence), ValueError, OptimizeWarning
        return fallback(type(exc).__name__)


@dataclass
class StopRule:
    until: Literal["ceiling", "budget"] = "ceiling"
    min_experiments: int = 10
    noise_k: int = 3
    noise_window: int = 10  # only keeps among the last `noise_window` experiments count as "recent"
    radical_k: int = 4
    saturation_min_points: int = 6
    external_ref: float | None = None  # oriented
    external_eps: float = 0.0
    max_experiments: int | None = 50
    max_cost_usd: float | None = None
    max_time_s: float | None = None

    def budget_exhausted(self, n_experiments: int, cost_usd: float, elapsed_s: float) -> StopReason | None:
        if self.max_experiments is not None and n_experiments >= self.max_experiments:
            return "max_experiments"
        if self.max_cost_usd is not None and cost_usd >= self.max_cost_usd:
            return "max_cost"
        if self.max_time_s is not None and elapsed_s >= self.max_time_s:
            return "max_time"
        return None

    def signals(self, history: list[HistoryPoint]) -> dict[str, dict[str, Any]]:
        report: dict[str, dict[str, Any]] = {}
        if not history:
            return report
        se = history[-1].best_se
        best = history[-1].best_mean

        window = history[-self.noise_window :]
        gains = [h.keep_gain for h in window if h.status == "keep" and h.keep_gain is not None]
        recent = gains[-self.noise_k :]
        if recent:
            fired = all(g < se for g in recent)
            detail = (
                f"the last {len(recent)} kept gains ({', '.join(f'{g:.4g}' for g in recent)}) were "
                f"{'each' if fired else 'not all'} below the CV standard error ({se:.4g})"
            )
            value: float | None = max(recent)
        else:
            fired = True
            detail = (
                f"no gains were kept in the last {len(window)} experiments; CV standard error is {se:.4g}"
            )
            value = None
        report["noise_floor"] = {"value": value, "threshold": se, "fired": fired, "detail": detail}

        curve = [h.best_mean for h in history]
        fit = fit_saturation(curve, self.saturation_min_points)
        rem = float(fit["remaining"])
        report["saturation"] = {
            "value": rem,
            "threshold": se,
            "fired": rem < se,
            "detail": f"the fitted curve ({fit['method']}) predicts at most {rem:.4g} more",
            "params": fit["params"],
        }

        last_keep = max((i for i, h in enumerate(history) if h.status == "keep"), default=-1)
        radicals = sum(1 for h in history[last_keep + 1 :] if h.radical and h.status != "keep")
        report["exploration"] = {
            "value": radicals,
            "threshold": self.radical_k,
            "fired": radicals >= self.radical_k,
            "detail": f"{radicals} radical attempts were rejected since the last keep "
            f"(need {self.radical_k})",
        }

        if self.external_ref is not None:
            gap = self.external_ref - best
            report["external_ref"] = {
                "value": best,
                "threshold": self.external_ref - self.external_eps,
                "fired": gap <= self.external_eps,
                "detail": f"best {best:.4g} vs external reference {self.external_ref:.4g} "
                f"(eps {self.external_eps})",
            }
        return report

    def check(
        self,
        history: list[HistoryPoint],
        *,
        n_experiments: int | None = None,
        cost_usd: float = 0.0,
        elapsed_s: float = 0.0,
    ) -> StopDecision:
        """`history` holds scored experiments since the first valid solution; `n_experiments` (default
        len(history)) counts every experiment, crashes included, for the experiment budget."""
        n = len(history) if n_experiments is None else n_experiments
        report = self.signals(history)
        budget = self.budget_exhausted(n, cost_usd, elapsed_s)
        ceiling = (
            self.until == "ceiling"
            and n >= self.min_experiments
            and bool(report)
            and all(sig["fired"] for sig in report.values())
        )
        last = history[-1].exp_id if history else "-"
        if ceiling:
            parts = [report[k]["detail"] for k in report]
            return StopDecision(
                True, "ceiling", report, f"stopped at experiment {last}: " + "; ".join(parts) + "."
            )
        if budget is not None:
            what = {
                "max_experiments": f"experiment budget reached ({n}/{self.max_experiments})",
                "max_cost": f"cost budget reached (${cost_usd:.4f} >= ${self.max_cost_usd})",
                "max_time": f"time budget reached ({elapsed_s:.0f}s >= {self.max_time_s}s)",
            }[budget]
            pending = [k for k, v in report.items() if not v["fired"]]
            tail = f" Ceiling signals not yet fired: {', '.join(pending)}." if pending else ""
            if self.until == "ceiling" and not pending and n < self.min_experiments:
                tail = (
                    f" All ceiling signals fired but min_experiments={self.min_experiments} was not reached."
                )
            return StopDecision(True, budget, report, f"stopped at experiment {last}: {what}.{tail}")
        return StopDecision(False, None, report, "")
