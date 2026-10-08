"""`python -m backend.migrate` (repo root) or `python migrate.py` (backend/). See autotinker_api/migrate.py."""

import sys
from pathlib import Path

_here = str(Path(__file__).resolve().parent)
if _here not in sys.path:
    sys.path.insert(0, _here)

from autotinker_api.migrate import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
