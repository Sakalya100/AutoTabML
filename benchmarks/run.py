"""Benchmark: starter baseline vs evolve (statistical gate) vs evolve (naive autoresearch-style gate).

Every system is scored once on the same locked test split, so the optimism gap (select - test) is comparable.

    uv run python benchmarks/run.py --llm heuristic --max-experiments 40
    uv run python benchmarks/run.py --llm anthropic:claude-sonnet-5-5 --datasets iris_na,breast_cancer

Writes benchmarks/results/<label>.json and benchmarks/results/<label>.md.
"""

from __future__ import annotations

import argparse
import json
import time
from collections.abc import Callable
from pathlib import Path

import pandas as pd
from sklearn import datasets as skd

from autotinker import AutoTinker

ROOT = Path(__file__).resolve().parent.parent


def _sk(loader: Callable[..., object], target: str) -> pd.DataFrame:
    frame: pd.DataFrame = loader(as_frame=True).frame  # type: ignore[attr-defined]
    return frame.rename(columns={"target": target})


DATASETS: dict[str, tuple[Callable[[], pd.DataFrame], str]] = {
    "iris_na": (lambda: pd.read_csv(ROOT / "examples/data/iris_na_classification.csv"), "variety"),
    "housing": (lambda: pd.read_csv(ROOT / "examples/data/housing_regression.csv"), "price"),
    "breast_cancer": (lambda: _sk(skd.load_breast_cancer, "malignant"), "malignant"),
    "wine": (lambda: _sk(skd.load_wine, "cultivar"), "cultivar"),
    "diabetes": (lambda: _sk(skd.load_diabetes, "progression"), "progression"),
}


def run_one(name: str, system: str, llm: str, max_exp: int, workdir: Path) -> dict[str, object]:
    load, target = DATASETS[name]
    df = load()
    gate = "naive" if system == "evolve_naive" else "stat"
    at = AutoTinker(llm=llm, workdir=workdir, gate=gate)
    t0 = time.time()
    if system == "starter":
        run = at.evolve(df, target, max_experiments=1, until="budget", run_id=f"{name}-{system}")
    elif system == "evolve_ceiling":
        run = at.evolve(df, target, max_experiments=max_exp * 2, until="ceiling", run_id=f"{name}-{system}")
    else:
        run = at.evolve(df, target, max_experiments=max_exp, until="budget", run_id=f"{name}-{system}")
    rec = run.record
    assert rec.final is not None
    metric = rec.profile.metric
    return {
        "dataset": name,
        "system": system,
        "metric": metric.value,
        "n_experiments": len(rec.experiments),
        "n_kept": sum(1 for e in rec.experiments if e.status.value == "keep"),
        "stop_reason": (rec.stop or {}).get("reason"),
        "dev_cv": metric.to_raw(rec.final.dev_cv_mean),
        "select": metric.to_raw(rec.final.select_score),
        "test": metric.to_raw(rec.final.test_score),
        "optimism_gap_oriented": rec.final.optimism_gap,
        "cost_usd": rec.total_cost_usd,
        "wall_s": round(time.time() - t0, 1),
    }


def to_markdown(rows: list[dict[str, object]], label: str) -> str:
    lines = [
        f"# Benchmark: `{label}`",
        "",
        "Scores are raw metric values on the locked test split (scored once per run). "
        "Optimism gap = select − test in oriented units (positive = the loop's own estimate was optimistic).",
        "",
        "| dataset | metric | system | experiments (kept) | stop "
        "| dev CV | select | **test** | gap | cost $ | time s |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['dataset']} | {r['metric']} | {r['system']} | {r['n_experiments']} ({r['n_kept']}) "
            f"| {r['stop_reason']} | {r['dev_cv']:.4g} | {r['select']:.4g} | **{r['test']:.4g}** "
            f"| {r['optimism_gap_oriented']:+.4g} | {r['cost_usd']:.3f} | {r['wall_s']} |"
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--llm", default="heuristic")
    ap.add_argument("--datasets", default=",".join(DATASETS))
    ap.add_argument("--systems", default="starter,evolve_stat,evolve_naive,evolve_ceiling")
    ap.add_argument("--max-experiments", type=int, default=40)
    ap.add_argument("--out", default=str(ROOT / "benchmarks/results"))
    args = ap.parse_args()

    label = args.llm.replace(":", "-")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    workdir = ROOT / "runs" / f"bench-{label}"
    rows: list[dict[str, object]] = []
    for name in args.datasets.split(","):
        for system in args.systems.split(","):
            row = run_one(name, system, args.llm, args.max_experiments, workdir)
            rows.append(row)
            print(json.dumps(row), flush=True)
    (out / f"{label}.json").write_text(json.dumps(rows, indent=2) + "\n")
    (out / f"{label}.md").write_text(to_markdown(rows, label))
    print(f"wrote {out / label}.json/.md")


if __name__ == "__main__":
    main()
