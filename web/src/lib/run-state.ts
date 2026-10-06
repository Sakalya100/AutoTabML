/**
 * One reducer turns an event prefix (+ optionally the final RunRecord) into everything the Run view draws.
 * Live mode feeds it the events received so far; replay mode feeds it `events.slice(0, cursor)` — so the
 * scrubber and the live stream share exactly the same code path.
 */
import type { AnyEvent, EventOf } from "./events";
import type { CVScore, DataProfile, Decision, ExperimentRecord, Idea, LLMUsage, Metric, RunRecord, TaskSpec } from "./schema";

export type ExpStatus = "running" | Decision;

export interface Attempt {
  attempt: number;
  ok: boolean;
  durationS: number;
  errorKind: string | null;
  errorTail: string | null;
}

export interface ExpView {
  id: string;
  index: number; // 0-based experiment number, the x axis of the chart
  parentId: string | null;
  idea: Idea;
  status: ExpStatus;
  reason: string;
  cv: CVScore | null;
  selectScore: number | null;
  fitTimeS: number | null;
  loc: number | null;
  attempts: Attempt[];
  llmCalls: LLMUsage[];
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
  durationS: number | null;
  /** Best kept experiment id after this experiment's decision. */
  bestAfter: string | null;
  bestMeanAfter: number | null;
  /** From the RunRecord (only available for replays / finished runs). */
  code?: string;
  diff?: string;
}

export interface StopSignal {
  key: string;
  value: unknown;
  threshold: unknown;
  fired: boolean | null;
  detail: string;
}

export interface StopView {
  reason: string;
  summary: string;
  signals: StopSignal[];
}

export interface FinalView {
  bestExpId: string;
  devCvMean: number;
  selectScore: number;
  testScore: number;
  optimismGap: number;
  nExperiments: number;
  totalCostUsd: number;
  wallTimeS: number;
}

export interface RunView {
  runId: string | null;
  task: TaskSpec | null;
  profile: DataProfile | null;
  config: Record<string, unknown>;
  proposer: string | null;
  metric: Metric | null;
  startedAt: string | null;
  lastTs: string | null;
  experiments: ExpView[];
  bestId: string | null;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  stop: StopView | null;
  final: FinalView | null;
  phase: "empty" | "running" | "stopped" | "finished";
  current: ExpView | null;
  eventCount: number;
}

export function emptyView(): RunView {
  return {
    runId: null,
    task: null,
    profile: null,
    config: {},
    proposer: null,
    metric: null,
    startedAt: null,
    lastTs: null,
    experiments: [],
    bestId: null,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    stop: null,
    final: null,
    phase: "empty",
    current: null,
    eventCount: 0,
  };
}

/** The four ceiling signals, keyed as in evolve/stopping.py. external_ref is absent when no reference is configured. */
export const SIGNAL_ORDER = ["noise_floor", "saturation", "exploration", "external_ref"];

export function stopSignals(report: Record<string, unknown> | null | undefined): StopSignal[] {
  if (!report) return [];
  const out: StopSignal[] = [];
  for (const [key, raw] of Object.entries(report)) {
    const r = (raw && typeof raw === "object" ? raw : { value: raw }) as Record<string, unknown>;
    out.push({
      key,
      value: r.value ?? null,
      threshold: r.threshold ?? null,
      fired: typeof r.fired === "boolean" ? r.fired : null,
      detail: typeof r.detail === "string" ? r.detail : "",
    });
  }
  for (const key of SIGNAL_ORDER)
    if (!out.some((s) => s.key === key))
      out.push({
        key,
        value: null,
        threshold: null,
        fired: null,
        detail: key === "external_ref" ? "Not configured for this run — no external reference score was given." : "Not reported by the engine.",
      });
  const rank = (k: string) => {
    const i = SIGNAL_ORDER.indexOf(k);
    return i === -1 ? SIGNAL_ORDER.length : i;
  };
  return out.sort((a, b) => rank(a.key) - rank(b.key));
}

function secondsBetween(a: string, b: string): number | null {
  const d = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/** Fold an ordered event list into a view. Pure; O(events). */
export function buildView(events: readonly AnyEvent[], record?: RunRecord | null): RunView {
  const v = emptyView();
  const byId = new Map<string, ExpView>();
  let currentBest: string | null = null;
  let currentBestMean: number | null = null;

  for (const ev of events) {
    v.eventCount++;
    v.lastTs = ev.ts;
    v.runId ??= ev.run_id;
    switch (ev.type) {
      case "run_started": {
        const e = ev as EventOf<"run_started">;
        v.task = e.task;
        v.profile = e.profile;
        v.config = e.config ?? {};
        v.proposer = e.proposer;
        v.metric = e.profile?.metric ?? e.task?.metric ?? null;
        v.startedAt = e.ts;
        v.phase = "running";
        break;
      }
      case "experiment_started": {
        const e = ev as EventOf<"experiment_started">;
        const x: ExpView = {
          id: e.exp_id,
          index: v.experiments.length,
          parentId: e.parent_id ?? null,
          idea: e.idea,
          status: "running",
          reason: "",
          cv: null,
          selectScore: null,
          fitTimeS: null,
          loc: null,
          attempts: [],
          llmCalls: [],
          costUsd: 0,
          startedAt: e.ts,
          endedAt: null,
          durationS: null,
          bestAfter: currentBest,
          bestMeanAfter: currentBestMean,
        };
        byId.set(x.id, x);
        v.experiments.push(x);
        if (v.phase === "empty") v.phase = "running";
        break;
      }
      case "llm_call": {
        const e = ev as EventOf<"llm_call">;
        v.totalCostUsd += e.usage.cost_usd ?? 0;
        v.totalInputTokens += e.usage.input_tokens ?? 0;
        v.totalOutputTokens += e.usage.output_tokens ?? 0;
        const x = e.exp_id ? byId.get(e.exp_id) : undefined;
        if (x) {
          x.llmCalls.push(e.usage);
          x.costUsd += e.usage.cost_usd ?? 0;
        }
        break;
      }
      case "sandbox_finished": {
        const e = ev as EventOf<"sandbox_finished">;
        byId.get(e.exp_id)?.attempts.push({
          attempt: e.attempt,
          ok: e.ok,
          durationS: e.duration_s,
          errorKind: e.error_kind ?? null,
          errorTail: e.error_tail ?? null,
        });
        break;
      }
      case "experiment_scored": {
        const e = ev as EventOf<"experiment_scored">;
        const x = byId.get(e.exp_id);
        if (x) {
          x.cv = e.cv;
          x.selectScore = e.select_score;
          x.fitTimeS = e.fit_time_s ?? null;
          x.loc = e.loc ?? null;
        }
        break;
      }
      case "decision": {
        const e = ev as EventOf<"decision">;
        currentBest = e.best_exp_id;
        currentBestMean = e.best_cv_mean;
        v.bestId = currentBest;
        const x = byId.get(e.exp_id);
        if (x) {
          x.status = e.decision;
          x.reason = e.reason ?? "";
          x.endedAt = e.ts;
          x.durationS = secondsBetween(x.startedAt, e.ts);
          x.bestAfter = currentBest;
          x.bestMeanAfter = currentBestMean;
        }
        break;
      }
      case "stopped": {
        const e = ev as EventOf<"stopped">;
        v.stop = { reason: e.reason, summary: e.summary, signals: stopSignals(e.report) };
        v.phase = "stopped";
        break;
      }
      case "run_finished": {
        const e = ev as EventOf<"run_finished">;
        v.final = {
          bestExpId: e.best_exp_id,
          devCvMean: e.dev_cv_mean,
          selectScore: e.select_score,
          testScore: e.test_score,
          optimismGap: e.optimism_gap,
          nExperiments: e.n_experiments,
          totalCostUsd: e.total_cost_usd,
          wallTimeS: e.wall_time_s,
        };
        v.bestId = e.best_exp_id;
        v.phase = "finished";
        break;
      }
    }
  }

  if (record) mergeRecord(v, byId, record);
  v.current = [...v.experiments].reverse().find((x) => x.status === "running") ?? null;
  return v;
}

/** Attach code/diff (only the RunRecord has them) and prefer its durations/costs. */
function mergeRecord(v: RunView, byId: Map<string, ExpView>, record: RunRecord) {
  v.task ??= record.task;
  v.profile ??= record.profile;
  v.proposer ??= record.proposer;
  v.metric ??= record.profile?.metric ?? null;
  for (const r of record.experiments ?? []) {
    const x = byId.get(r.id);
    if (!x) continue; // not reached yet in a replay prefix
    x.code = r.code;
    x.diff = r.diff ?? "";
    if (x.status !== "running") {
      if (r.duration_s) x.durationS = r.duration_s;
      if (r.llm_calls?.length && !x.llmCalls.length) x.llmCalls = r.llm_calls;
      if (r.cost_usd && !x.costUsd) x.costUsd = r.cost_usd;
    }
  }
}

/** Points for the best-so-far step line: one per decided experiment. */
export function bestTrajectory(v: RunView): { index: number; id: string; mean: number; se: number }[] {
  const out: { index: number; id: string; mean: number; se: number }[] = [];
  const byId = new Map(v.experiments.map((x) => [x.id, x]));
  for (const x of v.experiments) {
    if (x.status === "running" || !x.bestAfter || x.bestMeanAfter == null) continue;
    const best = byId.get(x.bestAfter);
    out.push({ index: x.index, id: x.bestAfter, mean: x.bestMeanAfter, se: best?.cv?.se ?? 0 });
  }
  return out;
}

export function parentOf(v: RunView, x: ExpView): ExpView | null {
  return x.parentId ? (v.experiments.find((p) => p.id === x.parentId) ?? null) : null;
}

export type { ExperimentRecord };
