from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from autotabml.data import DataSourceError, load_dataframe, load_source

DATA = Path(__file__).resolve().parent.parent / "examples" / "data"


def test_load_csv_and_na_parsing() -> None:
    df = load_source(str(DATA / "iris_na_classification.csv"))
    assert df.shape == (150, 5)
    assert df["sepal.width"].isna().sum() == 2  # literal "NA" and an empty cell
    assert pd.api.types.is_float_dtype(df["sepal.width"])


def test_quoted_header_and_path_object() -> None:
    df = load_source(DATA / "iris_classification.csv")
    assert list(df.columns) == ["sepal.length", "sepal.width", "petal.length", "petal.width", "variety"]


def test_tsv_and_whitespace_column_names(tmp_path: Path) -> None:
    p = tmp_path / "x.tsv"
    p.write_text(" a \tb\n1\tx\n2\ty\n")
    df = load_source(str(p))
    assert list(df.columns) == ["a", "b"]


def test_load_dataframe_passthrough_copies() -> None:
    src = pd.DataFrame({" x": [1, 2], "y": [3, 4]})
    out = load_dataframe(src)
    assert list(out.columns) == ["x", "y"]
    assert list(src.columns) == [" x", "y"]


def test_errors(tmp_path: Path) -> None:
    with pytest.raises(DataSourceError, match="not found"):
        load_source(str(tmp_path / "missing.csv"))
    bad = tmp_path / "x.xlsx"
    bad.write_text("x")
    with pytest.raises(DataSourceError, match="unsupported"):
        load_source(str(bad))
    with pytest.raises(DataSourceError, match="numeric id"):
        load_source("openml:abc")
    with pytest.raises(DataSourceError, match="kaggle spec"):
        load_source("kaggle:onlyowner")


def test_optional_packages_give_helpful_error() -> None:
    try:
        import openml  # noqa: F401
    except ImportError:
        with pytest.raises(DataSourceError, match="autotabml\\[openml\\]"):
            load_source("openml:61")
    try:
        import kagglehub  # noqa: F401
    except ImportError:
        with pytest.raises(DataSourceError, match="autotabml\\[kaggle\\]"):
            load_source("kaggle:owner/dataset")


def test_parquet_without_pyarrow_is_clear(tmp_path: Path) -> None:
    try:
        import pyarrow  # noqa: F401
    except ImportError:
        p = tmp_path / "x.parquet"
        p.write_bytes(b"PAR1")
        with pytest.raises(DataSourceError, match="pyarrow"):
            load_source(str(p))
    else:
        p = tmp_path / "x.parquet"
        pd.DataFrame({"a": [1, 2]}).to_parquet(p)
        assert load_source(str(p)).shape == (2, 1)
