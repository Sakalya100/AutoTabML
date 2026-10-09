import type { SurveyPose } from "@/lib/survey/contract";
/**
 * Everything the landing page states as a number, derived from ONE real replay (run.json + events.jsonl).
 * Pure and server-safe: page.tsx computes it once and hands a small serialisable object to the client.
 * Nothing here is invented — if a field is missing in the replay, it is null and the UI says so.
 */
import type { AnyEvent } from "@/lib/events";
import { describeGap } from "@/lib/metrics";
import { buildView, stopSignals, type RunView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { layoutSurvey } from "@/lib/survey/layout";

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
  /** Map length (x/z, world units) of each roll of the bead between consecutive keeps — paces the climb. */
  climbLengths: number[];
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
    climbLengths: climbLengths(events),
    survey: surveyNumbers(v),
  };
}

/** x/z length of each roll between consecutive keeps, on the same map the landing draws (buildView(events)). */
export function climbLengths(events: readonly AnyEvent[]): number[] {
  return climbLengthsOf(buildView(events));
}

/** The same for a view already built (replay pages pass the view they draw). */
export function climbLengthsOf(full: RunView): number[] {
  const c = layoutSurvey(full, full).climb;
  const out: number[] = [];
  for (let i = 0; i + 1 < c.length; i++) out.push(Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][2] - c[i][2]));
  return out;
}

/** Climb-section progress where the bead starts / finishes rolling (a short rest at each end of the section). */
export const ROLL_FROM = 0.03;
export const ROLL_TO = 0.97;
/** Fraction of the roll spent easing in (and out): everywhere else the bead rolls at one constant map speed. */
const ROLL_EASE = 0.07;

/** 0..1 → 0..1, linear with short quadratic ease-in / ease-out ramps (speed ≤ 1/(1 − ROLL_EASE) × the mean). */
export function paced(u: number): number {
  const a = ROLL_EASE;
  const x = Math.min(1, Math.max(0, u));
  const v = 1 / (1 - a); // top speed
  if (x < a) return (v * x * x) / (2 * a);
  if (x > 1 - a) return 1 - (v * (1 - x) * (1 - x)) / (2 * a);
  return (v * a) / 2 + v * (x - a);
}

/** Growth-step index at which keep j (0 = the baseline) was decided. */
function keepSteps(facts: LandingFacts): number[] {
  const g = facts.growth;
  const out: number[] = [];
  for (let i = 1; i < g.length; i++) if (g[i].kept > g[i - 1].kept) out.push(i);
  return out;
}

/**
 * Where the bead is along the climb path (index into the kept probes, fractional while it rolls) for a scroll
 * position. The whole climb — every roll from the baseline to the final best — is spread over the climb section (its
 * three messages) at one constant speed along the map, easing only at the very start and end: it never rushes and is
 * never parked while the climb's copy is on screen. Before the climb it rests on the baseline, after it on the summit.
 */
export function beadTFor(pose: SurveyPose, p: number, facts: LandingFacts, reduced: boolean): number {
  const L = facts.climbLengths;
  const n = L.length; // number of rolls
  switch (pose) {
    case "orbit":
    case "approach":
    case "first-probe":
      return 0;
    case "climb": {
      if (reduced || n === 0) return n;
      const total = L.reduce((x, y) => x + y, 0);
      if (!(total > 0)) return n * paced((p - ROLL_FROM) / (ROLL_TO - ROLL_FROM));
      let s = total * paced((p - ROLL_FROM) / (ROLL_TO - ROLL_FROM));
      if (s >= total) return n; // land exactly on the last keep (subtracting the rolls can leave n - 1e-16)
      for (let i = 0; i < n; i++) {
        if (s <= L[i]) return i + (L[i] > 0 ? s / L[i] : 1);
        s -= L[i];
      }
      return n;
    }
    default:
      return n;
  }
}

/**
 * Section → which moment of the replay the rail's numbers show (the 3D stage always shows the complete run). Strictly
 * monotonic down the page. In the climb the experiment count follows the bead: the experiments between two keeps are
 * counted through while the bead rolls between them, and keep j is counted exactly as the bead arrives at it. The
 * experiments after the last keep are counted through during the mist (the bead rests on the summit). Then the stop
 * (ceiling) and the locked test (truth, chart).
 */
export function cursorFor(pose: SurveyPose, p: number, facts: LandingFacts, reduced: boolean): { cursor: number; step: number } {
  const g = facts.growth;
  const last = g.length - 1; // the stop
  const preStop = Math.max(1, last - 1);
  const first = Math.min(1, last); // the baseline probe (e000) has landed and the bead sits on it
  const ks = keepSteps(facts);
  const lastKeep = ks.length ? Math.min(preStop, ks[ks.length - 1]) : first;
  const at = (i: number) => {
    const step = Math.min(last, Math.max(0, i));
    return { cursor: g[step].cursor, step };
  };
  const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
  switch (pose) {
    case "orbit":
    case "approach":
    case "first-probe":
      return at(first);
    case "climb": {
      if (reduced) return at(lastKeep);
      if (ks.length < 2) return at(first + Math.floor(clamp01(p) * (lastKeep - first)));
      const t = beadTFor("climb", p, facts, false);
      const j = Math.min(ks.length - 2, Math.floor(t));
      const f = t - j;
      // keep j+1 is decided only when the bead reaches it (f = 1); the steps in between are counted on the way
      const step = f >= 1 - 1e-9 ? ks[j + 1] : ks[j] + Math.floor(f * (ks[j + 1] - ks[j]));
      return at(Math.max(first, step));
    }
    case "mist":
      if (reduced) return at(preStop);
      return at(lastKeep + Math.floor(clamp01((p - 0.05) / 0.8) * (preStop - lastKeep) + 1e-9));
    case "ceiling":
      return at(last);
    case "truth":
    case "chart":
    default:
      return { cursor: facts.end, step: last };
  }
}
