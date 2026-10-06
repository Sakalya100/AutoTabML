"""Copy finished engine runs into the web app as replays and rebuild web/public/replays/index.json.

    uv run python benchmarks/export_replays.py runs/bench-heuristic/iris_na-evolve_ceiling:iris ...

Each argument is <run dir>[:<replay name>]. Existing replays not named on the command line are kept,
except hand-written fixtures, which are dropped from the index (they stay available to the fake engine).
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from autotabml.obs.record import RunRecord

ROOT = Path(__file__).resolve().parent.parent
REPLAYS = ROOT / "web/public/replays"


def entry(name: str, rec: RunRecord) -> dict[str, object]:
    p = rec.profile
    n_feat = len(p.columns)
    shape = f"{p.n_rows} rows, {n_feat} features"
    if p.problem_type.value != "regression":
        shape += f", {len(p.target_summary.get('counts', p.target_summary))} classes"
    kept = sum(1 for e in rec.experiments if e.status.value == "keep")
    stop = (rec.stop or {}).get("reason", "?")
    who = "offline heuristic proposer (no LLM)" if rec.proposer == "heuristic" else rec.proposer
    return {
        "name": name,
        "title": f"{name.replace('_', ' ').title()} — {who}",
        "dataset": f"{name} ({shape})",
        "metric": p.metric.value,
        "proposer": rec.proposer,
        "n_experiments": len(rec.experiments),
        "stop_reason": stop,
        "fixture": False,
        "blurb": f"Real engine run: {len(rec.experiments)} experiments, {kept} kept, stopped by '{stop}'.",
    }


def main(args: list[str]) -> None:
    index_path = REPLAYS / "index.json"
    existing = json.loads(index_path.read_text())["replays"] if index_path.exists() else []
    by_name = {r["name"]: r for r in existing if not r.get("fixture")}
    for arg in args:
        src_s, _, name = arg.partition(":")
        src = Path(src_s)
        name = name or src.name
        rec = RunRecord.model_validate_json((src / "run.json").read_text())
        dst = REPLAYS / name
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copy(src / "run.json", dst / "run.json")
        shutil.copy(src / "events.jsonl", dst / "events.jsonl")
        by_name[name] = entry(name, rec)
        print(f"exported {src} -> {dst}")
    index_path.write_text(json.dumps({"replays": list(by_name.values())}, indent=2) + "\n")
    print(f"index: {', '.join(by_name)}")


if __name__ == "__main__":
    main(sys.argv[1:])
