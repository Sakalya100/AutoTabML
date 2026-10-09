"""AutoTinker: a self-improving agent for tabular ML."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__version__ = "0.1.0"

if TYPE_CHECKING:
    from autotinker.api import AutoTinker, Run, load_run

__all__ = ["AutoTinker", "Run", "load_run", "__version__"]


def __getattr__(name: str) -> Any:  # lazy, so `import autotinker.contracts` stays light
    if name in ("AutoTinker", "Run", "load_run"):
        from autotinker import api

        return getattr(api, name)
    raise AttributeError(name)
