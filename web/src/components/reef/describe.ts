import { fmtNum, formatScore, metricInfo } from "@/lib/metrics";
import type { RunView } from "@/lib/run-state";
import { ceilingScore } from "@/lib/scene/layout";
import type { ColumnKind } from "@/lib/schema";
import type { NodeInfo, WorldLabels } from "./reef-world";

const STATUS: Record<string, string> = { keep: "kept", discard: "discarded", crash: "crashed", running: "running" };

/** Screen-reader summary, e.g. "Reef of 37 experiments, 4 kept, best ROC-AUC 0.9979". */
export function reefSummary(view: RunView): string {
  const n = view.experiments.length;
  if (!n) return "Reef visualisation: the run has not produced an experiment yet.";
  const kept = view.experiments.filter((x) => x.status === "keep").length;
  const crashed = view.experiments.filter((x) => x.status === "crash").length;
  const best = view.experiments.find((x) => x.id === view.bestId);
  const parts = [`Reef of ${n} experiment${n === 1 ? "" : "s"}`, `${kept} kept`];
  if (crashed) parts.push(`${crashed} crashed`);
  if (best?.cv) parts.push(`best ${metricInfo(view.metric).label} ${formatScore(view.metric, best.cv.mean)}`);
  if (view.phase === "stopped") parts.push("stopped at the ceiling, scoring the locked test");
  if (view.final) parts.push(`test ${formatScore(view.metric, view.final.testScore)}`);
  return parts.join(", ") + ". Every branch is also listed in the experiments ledger.";
}

export function describeNode(view: RunView, id: string): NodeInfo | null {
  const x = view.experiments.find((e) => e.id === id);
  if (!x) return null;
  const label = metricInfo(view.metric).label;
  return {
    title: x.idea?.title ?? id,
    status: STATUS[x.status] ?? x.status,
    score: x.cv ? `${label} ${formatScore(view.metric, x.cv.mean)} ± ${fmtNum(x.cv.se, 4)}` : x.status === "crash" ? "no score — crashed" : "scoring…",
  };
}

export function sceneLabels(view: RunView): WorldLabels {
  const m = view.metric;
  const ceil = ceilingScore(view);
  const out: WorldLabels = { sealed: "locked test · sealed" };
  if (ceil != null) out.ceiling = `fitted ceiling ≈ ${formatScore(m, ceil)}`;
  if (view.final) {
    const f = view.final;
    out.select = `select ${formatScore(m, f.selectScore)}`;
    out.test = `test ${formatScore(m, f.testScore)}`;
    const g = Math.abs(f.optimismGap);
    out.gap = f.optimismGap > 0 ? `optimism gap ${fmtNum(g, 4)}` : f.optimismGap < 0 ? `test beat select by ${fmtNum(g, 4)}` : "no gap";
  }
  return out;
}

export function columnKinds(view: RunView): ColumnKind[] {
  const target = view.profile?.target;
  return (view.profile?.columns ?? []).filter((c) => c.name !== target).map((c) => c.kind);
}
