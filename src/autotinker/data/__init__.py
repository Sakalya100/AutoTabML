"""Data loading (files, OpenML, Kaggle, public https URLs) and profiling."""

from autotinker.data.fetch import FetchError, FetchResult, fetch_url, read_fetched, rewrite_share_link
from autotinker.data.profiler import infer_problem_type, profile_dataframe, resolve_task
from autotinker.data.sources import DataSourceError, load_dataframe, load_source, source_stem

__all__ = [
    "DataSourceError",
    "FetchError",
    "FetchResult",
    "fetch_url",
    "infer_problem_type",
    "load_dataframe",
    "load_source",
    "profile_dataframe",
    "read_fetched",
    "resolve_task",
    "rewrite_share_link",
    "source_stem",
]
