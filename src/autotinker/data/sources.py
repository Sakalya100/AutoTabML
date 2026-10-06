"""Data source adapters: turn a user-supplied spec into a pandas DataFrame.

Specs understood by `load_source`:
  * a path to a ``.csv`` / ``.tsv`` / ``.parquet`` file
  * ``openml:<id>``                              (needs the optional ``openml`` package)
  * ``kaggle:<owner>/<dataset>[/<file.csv>]``    (needs the optional ``kagglehub`` package)
"""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any

import pandas as pd

# Strings that mean "missing" in the wild. pandas' defaults already cover most of these ("NA", "", "NaN",
# "null", ...); we pass them explicitly so behaviour does not drift across pandas versions.
NA_VALUES = ["", "NA", "N/A", "n/a", "NaN", "nan", "NULL", "null", "None", "#N/A", "?"]


class DataSourceError(ValueError):
    """Raised when a data source spec cannot be resolved or loaded."""


def _normalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Strip surrounding whitespace from column names; leave everything else untouched."""
    new = [str(c).strip() for c in df.columns]
    if len(set(new)) != len(new):
        raise DataSourceError(f"duplicate column names after stripping whitespace: {new}")
    out = df.copy()
    out.columns = pd.Index(new)
    return out


def load_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Pass-through adapter for an in-memory DataFrame (copied, column names normalised)."""
    if not isinstance(df, pd.DataFrame):
        raise DataSourceError(f"expected a pandas DataFrame, got {type(df).__name__}")
    return _normalise_columns(df)


def _read_file(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise DataSourceError(f"file not found: {path}")
    suffix = path.suffix.lower()
    if suffix in (".csv", ".tsv", ".txt"):
        sep = "\t" if suffix == ".tsv" else ","
        return pd.read_csv(path, sep=sep, na_values=NA_VALUES, keep_default_na=True)
    if suffix in (".parquet", ".pq"):
        try:
            return pd.read_parquet(path)
        except ImportError as e:
            raise DataSourceError(
                "reading parquet needs 'pyarrow' (or 'fastparquet'); install it with `uv add pyarrow`"
            ) from e
    raise DataSourceError(f"unsupported file type '{suffix}' (expected .csv, .tsv or .parquet)")


def _optional_import(module: str, extra: str) -> Any:
    try:
        return importlib.import_module(module)
    except ImportError as e:
        raise DataSourceError(
            f"this data source needs the optional '{module}' package; "
            f"install it with `pip install 'autotinker[{extra}]'`"
        ) from e


def _load_openml(ident: str) -> pd.DataFrame:
    if not ident.strip().isdigit():
        raise DataSourceError(f"openml spec must be 'openml:<numeric id>', got 'openml:{ident}'")
    openml = _optional_import("openml", "openml")
    dataset = openml.datasets.get_dataset(
        int(ident), download_data=True, download_qualities=False, download_features_meta_data=False
    )
    target = dataset.default_target_attribute
    X, y, _, _ = dataset.get_data(dataset_format="dataframe", target=None)
    df = X if y is None else pd.concat([X, y], axis=1)
    if target and target in df.columns:
        # Put the target last so it is easy to spot in previews.
        df = df[[c for c in df.columns if c != target] + [target]]
    return pd.DataFrame(df)


def _load_kaggle(ident: str) -> pd.DataFrame:
    parts = [p for p in ident.strip("/").split("/") if p]
    if len(parts) < 2:
        raise DataSourceError("kaggle spec must be 'kaggle:<owner>/<dataset>[/<file.csv>]'")
    handle = "/".join(parts[:2])
    file_part = "/".join(parts[2:]) or None
    kagglehub = _optional_import("kagglehub", "kaggle")
    root = Path(kagglehub.dataset_download(handle))
    if file_part:
        path = root / file_part
        if not path.exists():
            raise DataSourceError(f"file '{file_part}' not found in kaggle dataset '{handle}'")
        return _read_file(path)
    candidates = sorted(p for p in root.rglob("*") if p.suffix.lower() in (".csv", ".tsv", ".parquet", ".pq"))
    if not candidates:
        raise DataSourceError(f"no CSV/TSV/parquet files found in kaggle dataset '{handle}'")
    if len(candidates) > 1:
        names = ", ".join(str(p.relative_to(root)) for p in candidates[:10])
        raise DataSourceError(
            f"kaggle dataset '{handle}' has several data files ({names}); "
            f"pick one with 'kaggle:{handle}/<file>'"
        )
    return _read_file(candidates[0])


def load_source(spec: str | Path) -> pd.DataFrame:
    """Resolve a data source spec into a DataFrame with whitespace-stripped column names."""
    if isinstance(spec, Path):
        return _normalise_columns(_read_file(spec))
    spec = spec.strip()
    if spec.startswith("openml:"):
        df = _load_openml(spec[len("openml:") :])
    elif spec.startswith("kaggle:"):
        df = _load_kaggle(spec[len("kaggle:") :])
    else:
        df = _read_file(Path(spec).expanduser())
    return _normalise_columns(df)
