import type { SurveyPose } from "@/lib/survey/contract";
/**
 * Everything the landing page states as a number, derived from ONE real replay (run.json + events.jsonl).
 * Pure and server-safe: page.tsx computes it once and hands a small serialisable object to the client.
 * Nothing here is invented — if a field is missing in the replay, it is null and the UI says so.
 */
import type { AnyEvent } from "@/lib/events";
import { describeGap } from "@/lib/metrics";
import { buildView, stopSignals } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";

/** The run's state at one step of the scroll-scrubbed growth sequence. */
export interface GrowthStep {
  /** Event cursor: the reef shows buildView(events.slice(0, cursor)). */
  cursor: number;
  /** Experiments decided so far. */
  n: number;
  kept: number;
  /** Best oriented CV mean so far (null before the baseline is scored). */
  best: number | null;
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
  nRows: number | null;
  wallTimeS: number | null;
  stop: { reason: string; fired: number; signals: number } | null;
  final: { devCv: number; select: number; test: number; gap: number; gapText: string } | null;
  /**
   * The growth the pinned scroll sequence scrubs through: the run started (empty seabed), then one step per
   * decided experiment, ending on the `stopped` event (the surface appears). Monotonic cursors.
   */
  growth: GrowthStep[];
  /** Cursor of the whole run (the locked test opened). */
  end: number;
  /** The survey's own numbers (oriented scores; null when the replay lacks them). */
  survey: {
    /** CV mean of the first probe (the baseline). */
    baseline: number | null;
    /** Best CV mean and its standard error (the mist). */
    best: number | null;
    bestSe: number | null;
    /** Fitted ceiling = best + saturation.value (the cloud deck). */
    ceiling: number | null;
  };
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

export function growthSteps(events: readonly AnyEvent[]): GrowthStep[] {
  const cuts: number[] = [];
  const started = events.findIndex((e) => e.type === "run_started");
  cuts.push(started === -1 ? Math.min(1, events.length) : started + 1);
  events.forEach((e, i) => {
    if (e.type === "decision" || e.type === "stopped") cuts.push(i + 1);
  });
  return cuts.map((cursor) => {
    const v = buildView(events.slice(0, cursor));
    const decided = v.experiments.filter((x) => x.status !== "running");
    const best = v.experiments.find((x) => x.id === v.bestId)?.cv?.mean ?? null;
    return { cursor, n: decided.length, kept: decided.filter((x) => x.status === "keep").length, best };
  });
}

function surveyNumbers(v: ReturnType<typeof buildView>): LandingFacts["survey"] {
  const best = v.experiments.find((x) => x.id === v.bestId);
  const sat = num(v.stop?.signals.find((s) => s.key === "saturation")?.value);
  const bestMean = best?.cv?.mean ?? null;
  return {
    baseline: v.experiments[0]?.cv?.mean ?? null,
    best: bestMean,
    bestSe: best?.cv?.se ?? null,
    ceiling: bestMean != null && sat != null ? bestMean + sat : null,
  };
}

export function landingFacts(name: string, dataset: string, events: readonly AnyEvent[], rec: RunRecord): LandingFacts {
  const v = buildView(events, rec);
  const metric = v.metric ?? "score";
  const exps = rec.experiments ?? [];
  const status = (s: string) => exps.filter((e) => e.status === s).length;

  const stopRec = rec.stop as { reason?: string; report?: Record<string, unknown> } | null | undefined;
  const signals = stopSignals(stopRec?.report).filter((s) => s.fired != null);
  const f = v.final;

  return {
    name,
    dataset,
    proposer: v.proposer ?? rec.proposer ?? "unknown",
    metric,
    nExperiments: exps.length,
    nKept: status("keep"),
    nDiscarded: status("discard"),
    nCrashed: status("crash"),
    nRows: rec.profile?.n_rows ?? null,
    wallTimeS: num(rec.wall_time_s),
    stop: stopRec ? { reason: stopRec.reason ?? "", fired: signals.filter((s) => s.fired).length, signals: signals.length } : null,
    final: f ? { devCv: f.devCvMean, select: f.selectScore, test: f.testScore, gap: f.optimismGap, gapText: describeGap(metric, f.optimismGap) } : null,
    growth: growthSteps(events),
    end: events.length,
    survey: surveyNumbers(v),
  };
}

/**
 * Section → which moment of the replay it shows. Strictly monotonic down the page (hero = the start, chart = the end)
 * so scrolling only ever moves the run forward or backward along its own timeline: the bead never vanishes and
 * reappears, it just keeps rolling. Order of poses on the page: orbit/approach → first-probe → climb → mist →
 * ceiling → truth → chart.
 */
export function cursorFor(pose: SurveyPose, p: number, facts: LandingFacts, reduced: boolean): { cursor: number; step: number } {
  const g = facts.growth;
  const last = g.length - 1; // the stop
  const preStop = Math.max(1, last - 1);
  const first = Math.min(1, last); // the baseline probe (e000) has landed and the bead sits on it
  switch (pose) {
    case "orbit":
    case "approach":
    case "first-probe":
      return { cursor: g[first].cursor, step: first };
    case "climb": {
      if (reduced) return { cursor: g[preStop].cursor, step: preStop };
      const t = Math.min(1, Math.max(0, (p - 0.02) / 0.9));
      const i = Math.min(preStop, Math.max(first, first + Math.round(t * (preStop - first))));
      return { cursor: g[i].cursor, step: i };
    }
    case "mist":
      return { cursor: g[preStop].cursor, step: preStop };
    case "ceiling":
      return { cursor: g[last].cursor, step: last };
    case "truth":
    case "chart":
    default:
      return { cursor: facts.end, step: last };
  }
}
