from __future__ import annotations

import hashlib
import re

import numpy as np
import pytest

from autotabml.contracts import (
    ColumnKind,
    ColumnProfile,
    CVScore,
    DataProfile,
    ExecResult,
    Metric,
    ProblemType,
)

_SCORE = re.compile(r"#\s*fake-score:\s*([-0-9.]+)")


def make_profile(problem: ProblemType = ProblemType.multiclass) -> DataProfile:
    metric = Metric.log_loss if problem == ProblemType.multiclass else Metric.rmse
    if problem == ProblemType.binary:
        metric = Metric.roc_auc
    return DataProfile(
        n_rows=150,
        n_cols=5,
        target="y",
        problem_type=problem,
        metric=metric,
        columns=[
            ColumnProfile(name="a", dtype="float64", kind=ColumnKind.numeric, missing_frac=0.1, n_unique=40),
            ColumnProfile(name="b", dtype="float64", kind=ColumnKind.numeric, missing_frac=0.0, n_unique=30),
            ColumnProfile(
                name="c", dtype="object", kind=ColumnKind.categorical, missing_frac=0.0, n_unique=3
            ),
        ],
        target_summary={"classes": {"x": 50, "y": 50, "z": 50}},
    )


class FakeHarness:
    """Deterministic stand-in for autotabml.harness.Harness.

    Score comes from a `# fake-score: <float>` marker in the code (default 0.5, plus a tiny hash jitter);
    code containing `CRASH` fails with a runtime error. score_test may be called once."""

    def __init__(self, problem: ProblemType = ProblemType.multiclass, n_folds: int = 10, noise: float = 0.01):
        self.profile = make_profile(problem)
        self.allowed_imports = frozenset({"sklearn", "numpy", "pandas", "scipy"})
        self.n_folds = n_folds
        self.noise = noise
        self.evaluated: list[tuple[str, str]] = []
        self.test_calls = 0

    def _base(self, code: str) -> float:
        m = _SCORE.search(code)
        h = int(hashlib.sha256(code.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
        return (float(m.group(1)) if m else 0.5) + (0.0 if m else h * 1e-4)

    def evaluate(self, code: str, exp_id: str) -> ExecResult:
        self.evaluated.append((exp_id, code))
        if "CRASH" in code:
            return ExecResult(
                ok=False, error_kind="runtime", error_tail="Traceback ...\nValueError: boom", duration_s=0.1
            )
        base = self._base(code)
        rng = np.random.default_rng(0)  # same fold pattern for every experiment -> paired test
        folds = list(base + rng.normal(0, self.noise, self.n_folds))
        se = float(np.std(folds, ddof=1) / np.sqrt(len(folds)))
        return ExecResult(
            ok=True,
            cv=CVScore(mean=float(np.mean(folds)), se=se, folds=folds),
            select_score=base,
            fit_time_s=0.05,
            duration_s=0.1,
        )

    def score_test(self, code: str) -> float:
        self.test_calls += 1
        if self.test_calls > 1:
            raise RuntimeError("score_test called twice")
        return self._base(code) - 0.01


@pytest.fixture
def fake_harness() -> FakeHarness:
    return FakeHarness()
