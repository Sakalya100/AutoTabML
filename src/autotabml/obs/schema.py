"""Export JSON Schemas for the event stream and RunRecord so the web app can type and validate them.

Usage: python -m autotabml.obs.schema [out_dir]   (default: schema/)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from autotabml.obs.events import EventAdapter
from autotabml.obs.record import RunRecord


def main(out_dir: str = "schema") -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "events.schema.json").write_text(json.dumps(EventAdapter.json_schema(), indent=2) + "\n")
    (out / "run_record.schema.json").write_text(json.dumps(RunRecord.model_json_schema(), indent=2) + "\n")
    print(f"wrote {out}/events.schema.json and {out}/run_record.schema.json")


if __name__ == "__main__":
    main(*sys.argv[1:])
