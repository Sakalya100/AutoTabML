"""Harness: owns the data, the splits, the sandbox and the scoring. Read-only to the agent."""

from __future__ import annotations

import math
import re
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from autotinker.contracts import DataProfile, ExecResult, TaskSpec
from autotinker.data.profiler import profile_dataframe, resolve_task
from autotinker.harness import scorer
from autotinker.harness.sandbox import SandboxResult, run_in_sandbox
from autotinker.harness.splits import Splits, make_splits, persist_splits
from autotinker.harness.static_check import allowed_imports, static_check

_SAFE_ID = re.compile(r"[^A-Za-z0-9_.-]")


class Harness:
    """Satisfies `contracts.HarnessProtocol`.

    evaluate(): static check -> sandboxed worker (CV on dev + fit-on-dev/predict-select) -> scored here.
    score_test(): fit on dev+select, score the locked test split. Allowed exactly once.
    """

    def __init__(self, df: pd.DataFrame, task: TaskSpec, workdir: Path) -> None:
        self.workdir = Path(workdir).resolve()
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.task: TaskSpec = resolve_task(df, task)
        assert self.task.problem_type is not None and self.task.metric is not None
        self._splits: Splits = make_splits(df, self.task)
        dev_view = self._splits.X_dev.copy()
        if self._splits.classes is not None:
            dev_view[self.task.target] = [self._splits.classes[i] for i in self._splits.y_dev]
        else:
            dev_view[self.task.target] = self._splits.y_dev
        profile = profile_dataframe(df, self.task, sample_from=dev_view)
        extra = [w for w in self._splits.warnings if "missing target" not in w]
        self.profile: DataProfile = profile.model_copy(update={"warnings": profile.warnings + extra})
        self._profile_dict: dict[str, Any] = self.profile.model_dump(mode="json")
        self._dev_path, self._test_path = persist_splits(self._splits, self.workdir / "data")
        self.allowed_imports: frozenset[str] = allowed_imports()
        self._test_used = False
        self._n_runs = 0

    # ------------------------------------------------------------------ internals

    @property
    def n_folds(self) -> int:
        return len(self._splits.folds)

    @property
    def fold_indices(self) -> list[tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]]:
        """Fixed (train, val) positions into dev; identical for every evaluation (for paired tests)."""
        return [(tr.copy(), va.copy()) for tr, va in self._splits.folds]

    def _job_dir(self, label: str) -> Path:
        self._n_runs += 1
        safe = _SAFE_ID.sub("_", label)[:60] or "exp"
        return self.workdir / "runs" / f"{self._n_runs:04d}-{safe}"

    def _sandbox(self, code: str, mode: str, label: str) -> SandboxResult:
        assert self.task.metric is not None
        return run_in_sandbox(
            code,
            mode=mode,
            data_path=self._dev_path if mode == "cv" else self._test_path,
            job_dir=self._job_dir(label),
            profile=self._profile_dict,
            need_proba=scorer.needs_proba(self.task.metric),
            n_classes=self._splits.n_classes,
            timeout_s=self.task.experiment_timeout_s,
            memory_mb=self.task.experiment_memory_mb,
            seed=self.task.seed,
        )

    def _score(self, y_true: np.ndarray[Any, Any], pred: np.ndarray[Any, Any]) -> float:
        assert self.task.metric is not None and self.task.problem_type is not None
        return scorer.score(self.task.metric, self.task.problem_type, y_true, pred, self._splits.n_classes)

    @staticmethod
    def _load_preds(path: Path) -> dict[str, np.ndarray[Any, Any]]:
        with np.load(path, allow_pickle=False) as z:
            return {k: np.asarray(z[k]) for k in z.files}

    # ------------------------------------------------------------------ public API

    def evaluate(self, code: str, exp_id: str) -> ExecResult:
        """Run a candidate solution. Never raises for solution failures: returns ExecResult(ok=False)."""
        t0 = time.monotonic()
        errors, warns = static_check(code, self.allowed_imports)
        if errors:
            return ExecResult(
                ok=False,
                error_kind="static_check",
                error_tail="Static check failed:\n" + "\n".join(errors),
                static_warnings=warns,
                duration_s=time.monotonic() - t0,
            )
        res = self._sandbox(code, "cv", exp_id)
        if not res.ok or res.preds_path is None or res.payload is None:
            return ExecResult(
                ok=False,
                error_kind=res.error_kind or "runtime",  # type: ignore[arg-type]
                error_tail=res.error_tail,
                stdout_tail=res.stdout_tail,
                static_warnings=warns,
                duration_s=time.monotonic() - t0,
            )
        try:
            preds = self._load_preds(res.preds_path)
            y_dev = self._splits.y_dev
            folds: list[float] = []
            for i, (_, va) in enumerate(self._splits.folds):
                key = f"fold_{i}"
                if key not in preds:
                    raise scorer.InvalidOutput(f"missing predictions for {key}")
                folds.append(self._score(y_dev[va], preds[key]))
            if "select" not in preds:
                raise scorer.InvalidOutput("missing predictions for the select split")
            select = self._score(self._splits.y_select, preds["select"])
            fit_time = float(res.payload.get("fit_time_s", float("nan")))
        except (scorer.InvalidOutput, ValueError, OSError, KeyError) as e:
            return ExecResult(
                ok=False,
                error_kind="invalid_output",
                error_tail=f"Invalid output: {e}",
                stdout_tail=res.stdout_tail,
                static_warnings=warns,
                duration_s=time.monotonic() - t0,
            )
        return ExecResult(
            ok=True,
            cv=scorer.cv_score(folds),
            select_score=select,
            fit_time_s=fit_time if math.isfinite(fit_time) else None,
            duration_s=time.monotonic() - t0,
            stdout_tail=res.stdout_tail,
            static_warnings=warns,
        )

    def score_test(self, code: str) -> float:
        """Fit on dev+select and score the locked test split (oriented). Allowed exactly once per harness:
        the single shot is consumed on entry, even if the run fails."""
        if self._test_used:
            raise RuntimeError(
                "score_test has already been called; the locked test split is scored only once"
            )
        self._test_used = True
        errors, _ = static_check(code, self.allowed_imports)
        if errors:
            raise RuntimeError("score_test: static check failed:\n" + "\n".join(errors))
        res = self._sandbox(code, "test", "test")
        if not res.ok or res.preds_path is None:
            raise RuntimeError(f"score_test: solution failed ({res.error_kind}):\n{res.error_tail}")
        preds = self._load_preds(res.preds_path)
        if "test" not in preds:
            raise RuntimeError("score_test: worker produced no test predictions")
        try:
            return self._score(self._splits.y_test, preds["test"])
        except scorer.InvalidOutput as e:
            raise RuntimeError(f"score_test: invalid output: {e}") from e
