"""Vercel entrypoint (`main:app`, see the root vercel.json).

Locally: `uv run --project backend uvicorn backend.main:app`.

The app lives in the `autotinker_api` package next to this file; this directory is put on sys.path so the import works
both as `main` (Vercel, cwd = backend/) and as `backend.main` (repo root).
"""

import sys
from pathlib import Path

_here = str(Path(__file__).resolve().parent)
if _here not in sys.path:
    sys.path.insert(0, _here)

from autotinker_api.app import app  # noqa: E402

__all__ = ["app"]
