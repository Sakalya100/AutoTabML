"""The version in autotinker/__init__.py must match the installed package metadata (pyproject.toml)."""

from importlib import metadata

import autotinker


def test_version_matches_package_metadata() -> None:
    assert autotinker.__version__ == metadata.version("autotinker")
