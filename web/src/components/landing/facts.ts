/**
 * Everything the landing page states as a number, derived from ONE real replay (run.json + events.jsonl).
 * Pure and server-safe: page.tsx computes it once and hands a small serialisable object to the client.
 * Nothing here is invented — if a field is missing in the replay, it is null and the UI says so.
 */
import type { AnyEvent } from "@/lib/events";
import { describeGap } from "@/lib/metrics";
import { bestTrajectory, buildView, stopSignals, type StopSignal } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import type { SceneChapter } from "@/lib/scene/contract";

export interface ColumnFact {
  name: string;
  kind: string;
  missingFrac: number;
  /** min, q25, median, q75, max normalised to 0..1 within the column's own range (null if not numeric). */
  box: [number, number, number, number, number] | null;
  skew: number | null;
}

export interface FoldSide {
  id: string;
  title: string;
  mean: number;
  se: number;
  folds: number[];
}

export interface PairFact {
  decision: string;
  exp: FoldSide;
  parent: FoldSide;
  reason: string;
  p: number | null;
  gainSe: number | null;
}

export interface LandingFacts {
  name: string;
  dataset: string;
  proposer: string;
  metric: string;
  nExperiments: number;
  nKept: number;
  nDiscarded: number;
  nCrashed: number;
  wallTimeS: number | null;
  totalCostUsd: number;
  gate: { alpha: number | null; minGainSe: number | null };
  profile: {
    nRows: number;
    nCols: number;
    target: string;
    problemType: string;
    classCounts: [string, number][];
    kinds: [string, number][];
    flagged: number;
    sampleRows: number;
    columns: ColumnFact[];
  } | null;
  showcase: {
    id: string;
    parentId: string | null;
    title: string;
    rationale: string;
    category: string;
    radical: boolean;
    diff: { t: "+" | "-"; s: string }[];
    reason: string;
  } | null;
  keepPair: PairFact | null;
  discardPair: PairFact | null;
  stop: {
    reason: string;
    summary: string;
    signals: StopSignal[];
    saturationParams: [number, number, number] | null;
    se: number | null;
    /** Best-so-far mean after each experiment — the exact series the engine fits the saturation curve to. */
    trajectory: number[];
  } | null;
  final: { bestId: string; devCv: number; select: number; test: number; gap: number; gapText: string } | null;
  /** Event cursor per chapter, so the reef shows the run state that chapter talks about. null = loop. */
  cursors: Record<SceneChapter, number | null>;
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function parseReason(reason: string): { p: number | null; gainSe: number | null } {
  const p = /p=([0-9.e-]+)/.exec(reason);
  const se = /\(([+-][0-9.]+) SE/.exec(reason);
  return { p: p ? Number(p[1]) : null, gainSe: se ? Number(se[1]) : null };
}

/** Index just past the first event matching `pred` (a cursor for events.slice(0, cursor)). */
function after(events: readonly AnyEvent[], pred: (e: AnyEvent & Record<string, unknown>) => boolean): number | null {
  const i = events.findIndex((e) => pred(e as AnyEvent & Record<string, unknown>));
  return i === -1 ? null : i + 1;
}

export function cursorsFor(events: readonly AnyEvent[], showcaseId: string | null): Record<SceneChapter, number | null> {
  const end = events.length;
  const started = after(events, (e) => e.type === "run_started") ?? Math.min(1, end);
  const scored = showcaseId ? after(events, (e) => e.type === "experiment_scored" && e.exp_id === showcaseId) : null;
  const decided = showcaseId ? after(events, (e) => e.type === "decision" && e.exp_id === showcaseId) : null;
  const stopped = after(events, (e) => e.type === "stopped");
  // Selection shows every keep/wither the run made, but not yet the surface (that is the next chapter).
  const lastDecision = (() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "decision") return i + 1;
    return null;
  })();
  return {
    intro: null,
    overview: end,
    nutrients: started,
    mutation: scored ?? decided ?? end,
    selection: lastDecision ?? decided ?? end,
    ceiling: stopped ?? end,
    test: end,
  };
}

function side(rec: RunRecord, id: string): FoldSide | null {
  const x = (rec.experiments ?? []).find((e) => e.id === id);
  const cv = x?.cv as { mean?: number; se?: number; folds?: number[] } | null | undefined;
  if (!x || !cv || !Array.isArray(cv.folds) || cv.mean == null) return null;
  return { id: x.id, title: x.idea?.title ?? x.id, mean: cv.mean, se: cv.se ?? 0, folds: cv.folds };
}

function pair(rec: RunRecord, id: string | undefined): PairFact | null {
  if (!id) return null;
  const x = (rec.experiments ?? []).find((e) => e.id === id);
  if (!x?.parent_id) return null;
  const a = side(rec, id);
  const b = side(rec, x.parent_id);
  if (!a || !b || a.folds.length !== b.folds.length) return null;
  return { decision: String(x.status), exp: a, parent: b, reason: x.reason ?? "", ...parseReason(x.reason ?? "") };
}

export function landingFacts(name: string, dataset: string, events: readonly AnyEvent[], rec: RunRecord): LandingFacts {
  const v = buildView(events, rec);
  const metric = v.metric ?? "score";
  const exps = rec.experiments ?? [];
  const status = (s: string) => exps.filter((e) => e.status === s).length;

  const prof = rec.profile;
  const profile = prof
    ? {
        nRows: prof.n_rows,
        nCols: prof.n_cols,
        target: prof.target,
        problemType: prof.problem_type,
        classCounts: Object.entries(((prof.target_summary as Record<string, unknown>)?.class_counts ?? {}) as Record<string, number>),
        kinds: Object.entries(
          prof.columns.reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {}),
        ),
        flagged: prof.columns.filter((c) => (c.flags ?? []).length > 0).length,
        sampleRows: (prof.sample_rows ?? []).length,
        columns: prof.columns.map((c): ColumnFact => {
          const s = (c.stats ?? {}) as Record<string, unknown>;
          const q = [s.min, s.q25, s.q50, s.q75, s.max].map(num);
          const lo = q[0];
          const hi = q[4];
          const box =
            q.every((z) => z != null) && lo != null && hi != null && hi > lo
              ? (q.map((z) => ((z as number) - lo) / (hi - lo)) as ColumnFact["box"])
              : null;
          return { name: c.name, kind: c.kind, missingFrac: c.missing_frac ?? 0, box, skew: num(s.skew) };
        }),
      }
    : null;

  // The showcase mutation is the experiment that produced the final best (fallback: last kept non-baseline).
  const keptNonBase = exps.filter((e) => e.status === "keep" && e.parent_id);
  const showcaseRec = exps.find((e) => e.id === rec.best_exp_id && e.parent_id) ?? keptNonBase.at(-1) ?? null;
  const showcase = showcaseRec
    ? {
        id: showcaseRec.id,
        parentId: showcaseRec.parent_id ?? null,
        title: showcaseRec.idea?.title ?? showcaseRec.id,
        rationale: showcaseRec.idea?.rationale ?? "",
        category: String(showcaseRec.idea?.category ?? ""),
        radical: Boolean(showcaseRec.idea?.radical),
        diff: (showcaseRec.diff ?? "")
          .split("\n")
          .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"))
          .map((l) => ({ t: l[0] as "+" | "-", s: l.slice(1) })),
        reason: showcaseRec.reason ?? "",
      }
    : null;

  // Discarded example: the first experiment whose CV mean beat its parent yet still failed the gate —
  // the clearest picture of "a gain that is only noise". Fallback: the first discard.
  const discards = exps.filter((e) => e.status === "discard" && e.parent_id);
  const fooled = discards.find((e) => {
    const p = pair(rec, e.id);
    return p != null && p.exp.mean > p.parent.mean;
  });
  const discardPair = pair(rec, (fooled ?? discards[0])?.id);

  const stopRec = rec.stop as { reason?: string; summary?: string; report?: Record<string, unknown> } | null | undefined;
  const sat = (stopRec?.report?.saturation ?? null) as { params?: unknown; threshold?: unknown } | null;
  const params = Array.isArray(sat?.params) && sat.params.length === 3 && sat.params.every((z) => num(z) != null) ? (sat.params as [number, number, number]) : null;
  const stop = stopRec
    ? {
        reason: stopRec.reason ?? "",
        summary: stopRec.summary ?? "",
        signals: stopSignals(stopRec.report),
        saturationParams: params,
        se: num(sat?.threshold),
        trajectory: bestTrajectory(v).map((p) => p.mean),
      }
    : null;

  const f = v.final;
  const gate = ((rec.config as Record<string, unknown>)?.gate ?? {}) as Record<string, unknown>;

  return {
    name,
    dataset,
    proposer: v.proposer ?? rec.proposer ?? "unknown",
    metric,
    nExperiments: exps.length,
    nKept: status("keep"),
    nDiscarded: status("discard"),
    nCrashed: status("crash"),
    wallTimeS: num(rec.wall_time_s),
    totalCostUsd: num(rec.total_cost_usd) ?? 0,
    gate: { alpha: num(gate.alpha), minGainSe: num(gate.min_gain_se) },
    profile,
    showcase,
    keepPair: pair(rec, showcase?.id),
    discardPair,
    stop,
    final: f
      ? { bestId: f.bestExpId, devCv: f.devCvMean, select: f.selectScore, test: f.testScore, gap: f.optimismGap, gapText: describeGap(metric, f.optimismGap) }
      : null,
    cursors: cursorsFor(events, showcase?.id ?? null),
  };
}
