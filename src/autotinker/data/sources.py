"""Data source adapters: turn a user-supplied spec into a pandas DataFrame.

Specs understood by `load_source`:
  * a path to a ``.csv`` / ``.tsv`` / ``.parquet`` file
  * ``openml:<id>``                              (needs the optional ``openml`` package)
  * ``kaggle:<owner>/<dataset>[/<file.csv>]``    (needs the optional ``kagglehub`` package)
  * ``https://...`` a public URL to a CSV / TSV / parquet file; GitHub, Google Drive / Sheets and Hugging Face
    share links are rewritten to direct downloads (see `autotinker.data.fetch`)

`source_stem` turns any of these specs into a short filesystem-safe name (used for run ids).
"""

from __future__ import annotations

import importlib
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import pandas as pd

from autotinker.data.csvformat import CsvFormat, read_delimited

# Strings that mean "missing" in the wild. pandas' defaults already cover most of these ("NA", "", "NaN",
# "null", ...); we pass them explicitly so behaviour does not drift across pandas versions.
NA_VALUES = ["", "NA", "N/A", "n/a", "NaN", "nan", "NULL", "null", "None", "#N/A", "?"]


class DataSourceError(ValueError):
    """Raised when a data source spec cannot be resolved or loaded.

    `code` is the failure code the CLI reports in its `run_failed` event (see autotinker.failures):
    ``not_csv`` for content we cannot read as a table, ``download_failed`` for a link that could not be
    fetched (see FetchError)."""

    code: str = "not_csv"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


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


def read_text_table(data: bytes, fmt: CsvFormat | None, what: str = "file") -> pd.DataFrame:
    """Parse CSV/TSV bytes with `fmt` (whatever it leaves open is detected; see csvformat)."""
    try:
        return read_delimited(data, fmt, na_values=NA_VALUES)
    except UnicodeDecodeError as e:
        raise DataSourceError(f"could not decode the {what} as text: {e}") from e
    except (pd.errors.ParserError, pd.errors.EmptyDataError) as e:
        raise DataSourceError(f"could not parse the {what} as CSV: {e}") from e


def _read_file(path: Path, fmt: CsvFormat | None = None) -> pd.DataFrame:
    if not path.exists():
        raise DataSourceError(f"file not found: {path}", code="file_not_found")
    suffix = path.suffix.lower()
    if suffix in (".csv", ".tsv", ".txt"):
        return read_text_table(path.read_bytes(), fmt)
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


def _load_url(url: str, fmt: CsvFormat | None = None) -> pd.DataFrame:
    # Imported lazily: fetch.py imports DataSourceError / NA_VALUES from this module.
    from autotinker.data import fetch

    return fetch.read_fetched(fetch.fetch_url(fetch.rewrite_share_link(url)), fmt)


def _is_url(spec: str) -> bool:
    return re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", spec) is not None


def load_source(spec: str | Path, csv_format: CsvFormat | None = None) -> pd.DataFrame:
    """Resolve a data source spec into a DataFrame with whitespace-stripped column names.

    `csv_format` (delimiter / encoding / decimal; any may be None) applies to CSV/TSV files and links;
    whatever it leaves open is detected from the file."""
    if isinstance(spec, Path):
        return _normalise_columns(_read_file(spec, csv_format))
    spec = spec.strip()
    if _is_url(spec):
        scheme = spec.split(":", 1)[0].lower()
        if scheme != "https":
            raise DataSourceError(f"only https:// links are supported (got {scheme}://)")
        df = _load_url(spec, csv_format)
    elif spec.startswith("openml:"):
        df = _load_openml(spec[len("openml:") :])
    elif spec.startswith("kaggle:"):
        df = _load_kaggle(spec[len("kaggle:") :])
    else:
        df = _read_file(Path(spec).expanduser(), csv_format)
    return _normalise_columns(df)


_GENERIC_URL_SEGMENTS = frozenset({"export", "uc", "view", "edit", "download", "open", "raw", "resolve"})


def _safe_stem(text: str, max_len: int = 48) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-._")
    return stem[:max_len].rstrip("-._") or "data"


def source_stem(spec: str | Path) -> str:
    """A short filesystem-safe stem for a data source spec (for run ids)."""
    if isinstance(spec, Path):
        return _safe_stem(spec.stem)
    spec = spec.strip()
    if _is_url(spec):
        parts = urlsplit(spec)
        last = unquote(parts.path.rstrip("/").rsplit("/", 1)[-1])
        name = last.rsplit(".", 1)[0] if "." in last.strip(".") else last
        if not name or name.lower() in _GENERIC_URL_SEGMENTS:
            name = parts.hostname or "url"
        return _safe_stem(name)
    if spec.startswith(("openml:", "kaggle:")):
        return _safe_stem(spec.replace(":", "-").replace("/", "-"))
    return _safe_stem(Path(spec).expanduser().stem)
