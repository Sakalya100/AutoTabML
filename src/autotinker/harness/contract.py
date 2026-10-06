"""The solution.py contract: what the agent writes and what the harness guarantees in return."""

from __future__ import annotations

from autotinker.harness.static_check import BASE_ALLOWED_IMPORTS, OPTIONAL_IMPORTS, available_optional_imports

STARTER_SOLUTION = '''\
"""Baseline: impute, one-hot encode categoricals, gradient boosting."""

from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder


def build_pipeline(profile: dict):
    columns = profile["columns"]
    numeric = [c["name"] for c in columns if c["kind"] == "numeric"]
    categorical = [c["name"] for c in columns if c["kind"] in ("categorical", "boolean")]

    transformers = []
    if numeric:
        transformers.append(("num", SimpleImputer(strategy="median"), numeric))
    if categorical:
        cat = Pipeline(
            [
                ("impute", SimpleImputer(strategy="most_frequent")),
                ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=False, max_categories=30)),
            ]
        )
        transformers.append(("cat", cat, categorical))
    preprocess = ColumnTransformer(transformers, remainder="drop")

    if profile["problem_type"] == "regression":
        model = HistGradientBoostingRegressor(random_state=0)
    else:
        model = HistGradientBoostingClassifier(random_state=0)
    return Pipeline([("preprocess", preprocess), ("model", model)])
'''


def contract_doc(allowed: frozenset[str] | None = None) -> str:
    allowed = allowed if allowed is not None else BASE_ALLOWED_IMPORTS | available_optional_imports()
    libs = ", ".join(sorted(m for m in allowed if m != "__future__"))
    missing = [m for m in OPTIONAL_IMPORTS if m not in allowed]
    missing_note = f" Not available here: {', '.join(missing)}." if missing else ""
    return f"""\
SOLUTION CONTRACT (solution.py is the only file you write)

Define `build_pipeline(profile: dict)` returning an UNFITTED sklearn-compatible estimator.
- `profile` is the dataset profile as a plain dict (columns with name/kind/flags, problem_type, metric, ...).
- The harness calls `est.fit(X, y)` and then `est.predict(X)` / `est.predict_proba(X)`.
- X is the raw feature DataFrame: original column names and dtypes, target column removed, missing values
  as NaN. ALL preprocessing (imputation, encoding, scaling, feature engineering) must live inside the
  returned pipeline so it is re-fitted on each training fold.
- y: for classification, labels encoded as integers 0..k-1 (class i = i-th class in sorted order);
  predict must return those integers and predict_proba must have k columns (estimator `classes_` order).
  For regression, y is the float target.
- roc_auc / log_loss metrics need `predict_proba`. Predictions must be finite.
- The harness does all fitting, cross-validation and scoring; you never see the data files.

Allowed imports: {libs}.{missing_note}
Forbidden: any other import (os, sys, subprocess, socket, pathlib, shutil, pickle, importlib, ctypes, ...);
open/exec/eval/compile/__import__/globals/getattr-on-dunders or any dunder attribute access (except
__init__); file or network IO such as pd.read_csv, np.load, .to_csv, sklearn.datasets; calling
.fit/.fit_transform/.fit_predict at module level or in build_pipeline (only inside methods of your own
estimator classes). Network access is blocked and each run has a wall-clock and memory budget.
"""


CONTRACT_DOC = contract_doc()
