"""Seeded dev / select / test split plus fixed repeated K-fold indices over dev.

What the sandbox worker may see is persisted separately from what only the parent keeps:
  * ``dev.pkl``  -> X_dev, y_dev, fold indices, X_select           (cv mode)
  * ``test.pkl`` -> X_dev+select, y_dev+select, X_test             (test mode)
The select and test *labels* never leave the parent process; scoring happens in the parent.
"""

from __future__ import annotations

import pickle
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from numpy.typing import NDArray
from sklearn.model_selection import RepeatedKFold, RepeatedStratifiedKFold, train_test_split

from autotinker.contracts import ProblemType, TaskSpec

IntArray = NDArray[np.int64]


@dataclass
class Splits:
    X_dev: pd.DataFrame
    y_dev: NDArray[Any]
    X_select: pd.DataFrame
    y_select: NDArray[Any]
    X_test: pd.DataFrame
    y_test: NDArray[Any]
    folds: list[tuple[IntArray, IntArray]]  # (train_idx, val_idx) positions into dev, fixed order
    classes: list[Any] | None  # original labels; encoded label i == classes[i]
    stratified: bool
    warnings: list[str] = field(default_factory=list)

    @property
    def n_classes(self) -> int:
        return len(self.classes) if self.classes is not None else 0


def _can_stratify(y: NDArray[Any], n_min: int) -> bool:
    _, counts = np.unique(y, return_counts=True)
    return bool(len(counts) > 1 and int(np.min(counts)) >= n_min)


def make_splits(df: pd.DataFrame, task: TaskSpec) -> Splits:
    """Split `df` for a resolved `task` (problem_type must be set). Deterministic for a given seed."""
    if task.problem_type is None:
        raise ValueError("make_splits needs a resolved TaskSpec (problem_type set)")
    if not 0 < task.select_frac < 1 or not 0 < task.test_frac < 1 or task.select_frac + task.test_frac >= 0.8:
        raise ValueError("select_frac and test_frac must be in (0, 1) and leave at least 20% for dev")
    warn: list[str] = []
    target = task.target
    n_missing = int(df[target].isna().sum())
    if n_missing:
        warn.append(f"{n_missing} rows with a missing target were dropped before splitting")
        df = df.loc[df[target].notna()]
    df = df.reset_index(drop=True)
    X = df.drop(columns=[target])
    classification = task.problem_type != ProblemType.regression

    classes: list[Any] | None = None
    if classification:
        uniques = pd.unique(df[target])
        try:
            ordered = sorted(uniques.tolist())
        except TypeError:
            ordered = sorted(uniques.tolist(), key=str)
        classes = ordered
        mapping = {c: i for i, c in enumerate(ordered)}
        y: NDArray[Any] = df[target].map(mapping).to_numpy(dtype=np.int64)
    else:
        y = df[target].to_numpy(dtype=float)

    seed = task.seed
    idx = np.arange(len(df))
    strat_ok = classification and _can_stratify(y, 2)
    if classification and not strat_ok:
        warn.append("some class has fewer than 2 rows; holdout splits are not stratified")
    rest_idx, test_idx = train_test_split(
        idx, test_size=task.test_frac, random_state=seed, stratify=y if strat_ok else None
    )
    rel_select = task.select_frac / (1.0 - task.test_frac)
    strat_ok2 = strat_ok and _can_stratify(y[rest_idx], 2)
    dev_idx, sel_idx = train_test_split(
        rest_idx, test_size=rel_select, random_state=seed + 1, stratify=y[rest_idx] if strat_ok2 else None
    )
    dev_idx, sel_idx, test_idx = np.sort(dev_idx), np.sort(sel_idx), np.sort(test_idx)

    y_dev = y[dev_idx]
    if task.cv_folds < 2:
        raise ValueError("cv_folds must be >= 2")
    stratified = classification and _can_stratify(y_dev, task.cv_folds)
    splitter: RepeatedStratifiedKFold | RepeatedKFold
    if stratified:
        splitter = RepeatedStratifiedKFold(
            n_splits=task.cv_folds, n_repeats=task.cv_repeats, random_state=seed
        )
    else:
        if classification:
            warn.append(f"some class has fewer than {task.cv_folds} rows in dev; CV folds are not stratified")
        splitter = RepeatedKFold(n_splits=task.cv_folds, n_repeats=task.cv_repeats, random_state=seed)
    folds = [
        (tr.astype(np.int64), va.astype(np.int64))
        for tr, va in splitter.split(np.zeros(len(dev_idx)), y_dev if stratified else None)
    ]

    return Splits(
        X_dev=X.iloc[dev_idx].reset_index(drop=True),
        y_dev=y_dev,
        X_select=X.iloc[sel_idx].reset_index(drop=True),
        y_select=y[sel_idx],
        X_test=X.iloc[test_idx].reset_index(drop=True),
        y_test=y[test_idx],
        folds=folds,
        classes=classes,
        stratified=stratified,
        warnings=warn,
    )


def persist_splits(splits: Splits, data_dir: Path) -> tuple[Path, Path]:
    """Write the worker-visible pieces (no select/test labels). Always overwrites. Returns (dev, test)."""
    data_dir.mkdir(parents=True, exist_ok=True)
    dev_path, test_path = data_dir / "dev.pkl", data_dir / "test.pkl"
    dev_payload = {
        "X_dev": splits.X_dev,
        "y_dev": splits.y_dev,
        "folds": splits.folds,
        "X_select": splits.X_select,
    }
    test_payload = {
        "X_fit": pd.concat([splits.X_dev, splits.X_select], ignore_index=True),
        "y_fit": np.concatenate([splits.y_dev, splits.y_select]),
        "X_test": splits.X_test,
    }
    for path, payload in ((dev_path, dev_payload), (test_path, test_payload)):
        tmp = path.with_suffix(".tmp")
        with tmp.open("wb") as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
        tmp.replace(path)
    return dev_path, test_path
