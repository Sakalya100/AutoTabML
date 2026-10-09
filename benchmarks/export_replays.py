"""Copy finished engine runs into the web app as replays and rebuild web/public/replays/index.json.

    uv run python benchmarks/export_replays.py runs/bench-heuristic/iris_na-evolve_ceiling:iris ...

Each argument is <run dir>[:<replay name>]. Existing replays not named on the command line are kept,
except hand-written fixtures, which are dropped from the index (they stay available to the fake engine).

The copies are published on the web, so local paths (repo root, home directory) and provider org ids are
scrubbed from them on the way out; nothing else is changed.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from autotinker.obs.record import RunRecord

ROOT = Path(__file__).resolve().parent.parent
REPLAYS = ROOT / "web/public/replays"


def entry(name: str, rec: RunRecord) -> dict[str, object]:
    p = rec.profile
    n_feat = len(p.columns)
    shape = f"{p.n_rows} rows, {n_feat} features"
    if p.problem_type.value != "regression":
        n_classes = p.target_summary.get("n_classes") or len(p.target_summary.get("class_counts", {}))
        shape += f", {n_classes} classes"
    kept = sum(1 for e in rec.experiments if e.status.value == "keep")
    stop = (rec.stop or {}).get("reason", "?")
    models = agent_models(rec)
    if rec.proposer == "heuristic":
        who = "offline heuristic proposer (no LLM)"
    elif rec.mode == "agentic":
        who = "AI agents" + (f" ({', '.join(models)})" if models else "")
    else:
        who = rec.proposer
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
        **({"models": models} if models else {}),
    }


def agent_models(rec: RunRecord) -> list[str]:
    """Models that served at least one agent call, most-used first ("gpt-oss-120b on Groq")."""
    by_model = (rec.usage or {}).get("by_model") or {}
    used = [(v.get("calls", 0), v) for v in by_model.values() if v.get("calls", 0) > 0]
    used.sort(key=lambda cv: -cv[0])
    return [f"{v['model'].split('/')[-1]} on {v['provider'].capitalize()}" for _, v in used]


def scrub(text: str) -> str:
    """Drop machine-specific paths and provider org ids from a file about to be published."""
    text = text.replace(str(ROOT) + "/", "").replace(str(ROOT), ".")
    text = text.replace(str(Path.home()), "~")
    text = re.sub(r"""/(?:private/)?(?:tmp|var/folders)/[^\s\\"']*""", "<tmp>", text)
    return re.sub(r"org_[0-9A-Za-z]+", "org_…", text)


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
        for f in ("run.json", "events.jsonl"):
            (dst / f).write_text(scrub((src / f).read_text()))
        keep = {
            k: by_name[name][k] for k in ("selection",) if k in by_name.get(name, {})
        }  # editorial, set by hand
        by_name[name] = {**entry(name, rec), **keep}
        print(f"exported {src} -> {dst}")
    index_path.write_text(json.dumps({"replays": list(by_name.values())}, indent=2) + "\n")
    print(f"index: {', '.join(by_name)}")


if __name__ == "__main__":
    main(sys.argv[1:])
