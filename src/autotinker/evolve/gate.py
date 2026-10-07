"""Keep/revert gates (ROADMAP §3.2).

`StatGate` (default): keep a candidate only if the improvement is statistically real on the dev CV folds
(one-sided Nadeau-Bengio corrected paired t-test across identical folds, p < alpha) AND the mean
gain is at least
`min_gain_se` x the best's CV standard error AND the select-holdout score is not worse than the best's by
more than `select_tol_se` x SE. A simplicity rule keeps changes with a negligible score change that make
the solution clearly smaller or faster.

`NaiveGate`: autoresearch-style, keep any improvement in mean CV score. Used for the ablation (§3.5a).

Gates never see crashes; the loop decides `crash` before calling the gate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

import numpy as np
from scipy import stats

from autotinker.contracts import Decision, ExecResult

_EPS = 1e-12


@dataclass(frozen=True)
class Candidate:
    """What a gate needs to know about one evaluated solution."""

    result: ExecResult
    loc: int


class Gate(Protocol):
    name: str

    def __call__(self, cand: Candidate, best: Candidate) -> tuple[Decision, str]: ...


def paired_one_sided_p(
    cand_folds: list[float], best_folds: list[float], test_train_ratio: float | None = None
) -> float:
    """p-value for H1: cand > best, paired across identical folds.

    With `test_train_ratio` (n_val / n_train of one fold, i.e. 1/(k-1) for k-fold CV) this is the
    Nadeau-Bengio corrected resampled t-test: CV folds share training rows, so the per-fold differences
    are positively correlated and the plain paired t-test is overconfident. The correction inflates the
    variance from var/n to var * (1/n + n_val/n_train). With None it is the plain paired t-test.
    """
    a = np.asarray(cand_folds, dtype=float)
    b = np.asarray(best_folds, dtype=float)
    if a.shape != b.shape or a.size < 2:
        return 1.0
    d = a - b
    if float(np.std(d)) < _EPS:
        # Identical improvement on every fold: deterministic; no variance to test against.
        return 0.0 if float(np.mean(d)) > _EPS else 1.0
    n = d.size
    var = float(np.var(d, ddof=1))
    scale = 1.0 / n + (test_train_ratio or 0.0)
    t = float(np.mean(d)) / math.sqrt(var * scale)
    p = float(stats.t.sf(t, df=n - 1))
    return 1.0 if math.isnan(p) else p


def _fmt(x: float) -> str:
    return f"{x:.4g}"


@dataclass
class StatGate:
    alpha: float = 0.1
    min_gain_se: float = 0.5  # mean gain must be >= this x best's CV SE
    select_tol_se: float = 1.0  # select may drop by at most this x best's CV SE
    simplify_gain_se: float = 0.25  # |gain| below this x SE counts as "no change"
    simplify_loc_frac: float = 0.15  # ... and LOC reduced by at least 15%
    simplify_time_ratio: float = 0.5  # ... or fit time at most half
    test_train_ratio: float | None = 0.25  # Nadeau-Bengio correction; 1/(k-1), 0.25 for 5-fold CV
    name: str = "stat"

    def __call__(self, cand: Candidate, best: Candidate) -> tuple[Decision, str]:
        c, b = cand.result, best.result
        if not c.ok or c.cv is None:
            return Decision.crash, "candidate did not produce a CV score"
        if b.cv is None:
            return Decision.keep, "no scored best yet"
        se = max(b.cv.se, _EPS)
        same_folds = len(c.cv.folds) == len(b.cv.folds) and len(c.cv.folds) > 0
        gain = (
            float(np.mean(np.asarray(c.cv.folds) - np.asarray(b.cv.folds)))
            if same_folds
            else c.cv.mean - b.cv.mean
        )
        p = paired_one_sided_p(c.cv.folds, b.cv.folds, self.test_train_ratio) if same_folds else 1.0

        select_ok = True
        select_txt = "select n/a"
        if c.select_score is not None and b.select_score is not None:
            floor = b.select_score - self.select_tol_se * se
            select_ok = c.select_score >= floor
            select_txt = f"select {_fmt(c.select_score)} vs best {_fmt(b.select_score)} (floor {_fmt(floor)})"

        nums = f"gain {_fmt(gain)} ({gain / se:+.2f} SE, SE={_fmt(se)}), p={p:.3g}, {select_txt}"

        # Simplicity rule: score unchanged within noise, but clearly simpler or faster.
        if abs(gain) < self.simplify_gain_se * se and select_ok:
            loc_red = (best.loc - cand.loc) / best.loc if best.loc > 0 else 0.0
            t_c, t_b = c.fit_time_s, b.fit_time_s
            faster = t_c is not None and t_b is not None and t_b > 0 and t_c <= self.simplify_time_ratio * t_b
            if loc_red >= self.simplify_loc_frac or faster:
                why = []
                if loc_red >= self.simplify_loc_frac:
                    why.append(f"LOC {best.loc}->{cand.loc} (-{loc_red:.0%})")
                if faster:
                    why.append(f"fit time {_fmt(t_b or 0)}s->{_fmt(t_c or 0)}s")
                return Decision.keep, f"simplification: {', '.join(why)}; {nums}"

        if p >= self.alpha:
            return Decision.discard, f"not significant: p={p:.3g} >= alpha={self.alpha}; {nums}"
        if gain < self.min_gain_se * se:
            return Decision.discard, f"gain below {self.min_gain_se} SE; {nums}"
        if not select_ok:
            return Decision.discard, f"select holdout disagrees; {nums}"
        return Decision.keep, f"improvement: {nums}"


@dataclass
class NaiveGate:
    """Keep iff the mean CV score improves at all (autoresearch's rule)."""

    name: str = "naive"

    def __call__(self, cand: Candidate, best: Candidate) -> tuple[Decision, str]:
        c, b = cand.result, best.result
        if not c.ok or c.cv is None:
            return Decision.crash, "candidate did not produce a CV score"
        if b.cv is None:
            return Decision.keep, "no scored best yet"
        gain = c.cv.mean - b.cv.mean
        if gain > 0:
            return Decision.keep, f"naive: cv mean improved by {_fmt(gain)}"
        return Decision.discard, f"naive: cv mean did not improve ({_fmt(gain)})"


def naive_gate(cand: Candidate, best: Candidate) -> tuple[Decision, str]:
    return NaiveGate()(cand, best)


def make_gate(name: str, **kwargs: float) -> Gate:
    if name == "naive":
        return NaiveGate()
    if name == "stat":
        return StatGate(**kwargs)  # type: ignore[arg-type]
    raise ValueError(f"unknown gate {name!r} (expected 'stat' or 'naive')")
