/**
 * The agent-activity feed: groups the raw event stream into chat-like messages, one group per experiment
 * plus run-level messages (started / stopped / finished). Pure, so the live stream and the replay
 * simulation (`events.slice(0, cursor)`) render through exactly the same function.
 */
import type { AnyEvent, EventOf } from "./events";
import { stopSignals, type StopSignal } from "./run-state";
import type { Decision, Idea, Metric } from "./schema";

export interface FeedAttempt {
  attempt: number;
  ok: boolean;
  durationS: number;
  errorKind: string | null;
  errorTail: string | null;
}

/** What the gate's free-text reason says, pulled apart for display. Every field is optional: reasons vary by engine version. */
export interface GateSummary {
  /** Leading clause, e.g. "not significant", "improvement", "simplification". */
  label: string | null;
  p: number | null;
  /** Gain expressed in standard errors of the best's CV, signed. */
  gainSe: number | null;
}

export interface RunStartedItem {
  kind: "run_started";
  key: string;
  seq: number;
  nRows: number | null;
  nCols: number | null;
  target: string | null;
  problemType: string | null;
  metric: Metric | null;
  proposer: string | null;
  description: string | null;
  /** Feature columns by kind, largest first (target excluded). */
  columnKinds: [string, number][];
  /** Columns the profiler flagged (id-like, leak, high cardinality). */
  flagged: { name: string; flags: string[] }[];
  warnings: string[];
  maxExperiments: number | null;
}

export type ExpStage = "running" | "scored" | "decided";

export interface ExperimentItem {
  kind: "experiment";
  key: string;
  seq: number;
  id: string;
  index: number;
  parentId: string | null;
  idea: Idea;
  stage: ExpStage;
  attempts: FeedAttempt[];
  llmCalls: number;
  costUsd: number;
  scored: { cvMean: number; cvSe: number; select: number; fitTimeS: number | null; loc: number | null } | null;
  decision: {
    verdict: Decision;
    reason: string;
    gate: GateSummary;
    bestId: string;
    bestMean: number;
    /** This experiment became the best solution. */
    newBest: boolean;
  } | null;
}

export interface StoppedItem {
  kind: "stopped";
  key: string;
  seq: number;
  reason: string;
  summary: string;
  signals: StopSignal[];
}

export interface FinishedItem {
  kind: "finished";
  key: string;
  seq: number;
  bestId: string;
  devCvMean: number;
  select: number;
  test: number;
  gap: number;
  nExperiments: number;
  costUsd: number;
  wallTimeS: number;
}

export type FeedItem = RunStartedItem | ExperimentItem | StoppedItem | FinishedItem;

const num = (s: string | undefined): number | null => {
  if (s == null) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/** "not significant: p=0.228 >= alpha=0.1; gain 0.002261 (+0.94 SE, SE=0.002412), …" -> label/p/gainSe. */
export function parseGateReason(reason: string | null | undefined): GateSummary {
  const r = (reason ?? "").trim();
  if (!r) return { label: null, p: null, gainSe: null };
  const head = /^([a-z][a-z ]{1,40}):/i.exec(r);
  const p = /\bp\s*=\s*([0-9.]+(?:e-?\d+)?)/i.exec(r);
  const se = /\(([+\-−]?[0-9.]+)\s*SE\b/.exec(r);
  return {
    label: head ? head[1].trim().toLowerCase() : null,
    p: num(p?.[1]),
    gainSe: se ? num(se[1].replace("−", "-")) : null,
  };
}

/** Fold an ordered event prefix into feed items. O(events). */
export function buildFeed(events: readonly AnyEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  const byId = new Map<string, ExperimentItem>();
  let maxExperiments: number | null = null;

  for (const ev of events) {
    switch (ev.type) {
      case "run_started": {
        const e = ev as EventOf<"run_started">;
        const prof = e.profile;
        const kinds = new Map<string, number>();
        const flagged: { name: string; flags: string[] }[] = [];
        for (const c of prof?.columns ?? []) {
          if (c.name === prof.target) continue;
          kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
          if (c.flags?.length) flagged.push({ name: c.name, flags: c.flags });
        }
        const cfg = (e.config ?? {}) as Record<string, unknown>;
        const stopRule = (cfg.stop_rule ?? {}) as Record<string, unknown>;
        const max = cfg.max_experiments ?? stopRule.max_experiments;
        maxExperiments = typeof max === "number" ? max : null;
        out.push({
          kind: "run_started",
          key: `run-${e.seq}`,
          seq: e.seq,
          nRows: prof?.n_rows ?? null,
          nCols: prof?.n_cols ?? null,
          target: prof?.target ?? e.task?.target ?? null,
          problemType: prof?.problem_type ?? e.task?.problem_type ?? null,
          metric: prof?.metric ?? e.task?.metric ?? null,
          proposer: e.proposer ?? null,
          description: e.task?.description || null,
          columnKinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]),
          flagged,
          warnings: prof?.warnings ?? [],
          maxExperiments,
        });
        break;
      }
      case "experiment_started": {
        const e = ev as EventOf<"experiment_started">;
        const item: ExperimentItem = {
          kind: "experiment",
          key: `exp-${e.exp_id}`,
          seq: e.seq,
          id: e.exp_id,
          index: byId.size,
          parentId: e.parent_id ?? null,
          idea: e.idea,
          stage: "running",
          attempts: [],
          llmCalls: 0,
          costUsd: 0,
          scored: null,
          decision: null,
        };
        byId.set(item.id, item);
        out.push(item);
        break;
      }
      case "llm_call": {
        const e = ev as EventOf<"llm_call">;
        const x = e.exp_id ? byId.get(e.exp_id) : undefined;
        if (x) {
          x.llmCalls++;
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
          x.scored = { cvMean: e.cv.mean, cvSe: e.cv.se, select: e.select_score, fitTimeS: e.fit_time_s ?? null, loc: e.loc ?? null };
          x.stage = "scored";
        }
        break;
      }
      case "decision": {
        const e = ev as EventOf<"decision">;
        const x = byId.get(e.exp_id);
        if (x) {
          x.decision = {
            verdict: e.decision,
            reason: e.reason ?? "",
            gate: parseGateReason(e.reason),
            bestId: e.best_exp_id,
            bestMean: e.best_cv_mean,
            newBest: e.decision === "keep" && e.best_exp_id === e.exp_id,
          };
          x.stage = "decided";
        }
        break;
      }
      case "stopped": {
        const e = ev as EventOf<"stopped">;
        out.push({ kind: "stopped", key: `stop-${e.seq}`, seq: e.seq, reason: e.reason, summary: e.summary, signals: stopSignals(e.report) });
        break;
      }
      case "run_finished": {
        const e = ev as EventOf<"run_finished">;
        out.push({
          kind: "finished",
          key: `fin-${e.seq}`,
          seq: e.seq,
          bestId: e.best_exp_id,
          devCvMean: e.dev_cv_mean,
          select: e.select_score,
          test: e.test_score,
          gap: e.optimism_gap,
          nExperiments: e.n_experiments,
          costUsd: e.total_cost_usd,
          wallTimeS: e.wall_time_s,
        });
        break;
      }
    }
  }
  return out;
}

/** A string that changes whenever something visible in the feed changes (drives auto-scroll). */
export function feedSignature(items: readonly FeedItem[]): string {
  const last = items.at(-1);
  if (!last) return "0";
  const tail = last.kind === "experiment" ? `${last.stage}:${last.attempts.length}:${last.llmCalls}` : last.kind;
  return `${items.length}:${tail}`;
}

/** The experiment still in flight (the "typing" message), if any. */
export function inFlight(items: readonly FeedItem[]): ExperimentItem | null {
  const last = items.at(-1);
  return last?.kind === "experiment" && last.stage !== "decided" ? last : null;
}
