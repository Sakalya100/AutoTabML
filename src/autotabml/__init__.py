"""AutoTabML: a self-improving agent for tabular ML."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__version__ = "0.1.0.dev0"

if TYPE_CHECKING:
    from autotabml.api import AutoTabML, Run, load_run

__all__ = ["AutoTabML", "Run", "load_run", "__version__"]


def __getattr__(name: str) -> Any:  # lazy, so `import autotabml.contracts` stays light
    if name in ("AutoTabML", "Run", "load_run"):
        from autotabml import api

        return getattr(api, name)
    raise AttributeError(name)
