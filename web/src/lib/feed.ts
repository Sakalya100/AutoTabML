/**
 * The agent-activity feed: groups the raw event stream into chat-like messages, one group per experiment
 * plus run-level messages (started / stopped / finished). Pure, so the live stream and the replay
 * simulation (`events.slice(0, cursor)`) render through exactly the same function.
 */
import type { AnyEvent, EventOf } from "./events";
import { stopSignals, type StopSignal } from "./run-state";
import type { Decision, Idea, Metric } from "./schema";
import { isNewBest } from "./verdict";

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

/** One agent step as a feed line (agentic engine only). `running` until its agent_step_finished arrives. */
export interface AgentStepLine {
  stepId: string;
  role: string;
  plain: string;
  status: "ok" | "error" | null;
  model: string | null;
  attempt: number;
  running: boolean;
  inputSummary: string;
}

/** A run-level agent step (intake, profiler, reporter: no experiment). */
export interface AgentStepItem extends AgentStepLine {
  kind: "agent_step";
  key: string;
  seq: number;
}

/** The Reporter's final report (report_ready). Every field is read defensively. */
export interface ReportItem {
  kind: "report";
  key: string;
  seq: number;
  plain: string | null;
  summary: string | null;
  whatWorked: string[];
  caveats: string[];
  nextSteps: string[];
}

/** Sandbox log lines kept per experiment (the newest win). */
export const MAX_LOG_LINES = 200;

export interface ExperimentItem {
  kind: "experiment";
  key: string;
  seq: number;
  id: string;
  index: number;
  parentId: string | null;
  idea: Idea;
  stage: ExpStage;
  /** Agent steps for this experiment, in order (empty for heuristic/legacy runs). */
  steps: AgentStepLine[];
  /** Sandbox stdout/stderr lines, capped at MAX_LOG_LINES. */
  logs: string[];
  hpoTrials: number;
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
    /** Kept because it was better (a simplification replaces the best without being better). */
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

export type FeedItem = RunStartedItem | ExperimentItem | StoppedItem | FinishedItem | AgentStepItem | ReportItem;

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

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

interface Pending {
  steps: AgentStepLine[];
  logs: string[];
  hpo: number;
}

/** Fold an ordered event prefix into feed items. O(events). */
export function buildFeed(events: readonly AnyEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  const byId = new Map<string, ExperimentItem>();
  let maxExperiments: number | null = null;
  // Planner/coder steps arrive before their experiment_started: hold them until the experiment appears.
  const pending = new Map<string, Pending>();
  const holder = (expId: string): Pending => {
    const x = byId.get(expId);
    if (x) return x as unknown as Pending;
    let p = pending.get(expId);
    if (!p) pending.set(expId, (p = { steps: [], logs: [], hpo: 0 }));
    return p;
  };
  const runSteps = new Map<string, AgentStepItem>();

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
          steps: pending.get(e.exp_id)?.steps ?? [],
          logs: pending.get(e.exp_id)?.logs ?? [],
          hpoTrials: pending.get(e.exp_id)?.hpo ?? 0,
          attempts: [],
          llmCalls: 0,
          costUsd: 0,
          scored: null,
          decision: null,
        };
        pending.delete(e.exp_id);
        byId.set(item.id, item);
        out.push(item);
        break;
      }
      case "agent_step_started": {
        const e = ev as EventOf<"agent_step_started">;
        const line: AgentStepLine = {
          stepId: e.step_id,
          role: e.role,
          plain: "",
          status: null,
          model: null,
          attempt: e.attempt ?? 0,
          running: true,
          inputSummary: e.input_summary ?? "",
        };
        if (e.exp_id) holder(e.exp_id).steps.push(line);
        else {
          const item: AgentStepItem = { kind: "agent_step", key: `step-${e.step_id || e.seq}`, seq: e.seq, ...line };
          runSteps.set(e.step_id, item);
          out.push(item);
        }
        break;
      }
      case "agent_step_finished": {
        const e = ev as EventOf<"agent_step_finished">;
        const st = e.step;
        const stepId = st.step_id ?? "";
        const done: AgentStepLine = {
          stepId,
          role: st.role,
          plain: st.plain ?? "",
          status: st.status === "error" ? "error" : "ok",
          model: st.model ?? null,
          attempt: st.attempt ?? 0,
          running: false,
          inputSummary: st.input_summary ?? "",
        };
        if (e.exp_id) {
          const list = holder(e.exp_id).steps;
          const i = stepId ? list.findIndex((x) => x.stepId === stepId) : -1;
          if (i >= 0) list[i] = done;
          else list.push(done);
        } else {
          const item = stepId ? runSteps.get(stepId) : undefined;
          if (item) Object.assign(item, done);
          else out.push({ kind: "agent_step", key: `step-${stepId || e.seq}`, seq: e.seq, ...done });
        }
        break;
      }
      case "sandbox_log": {
        const e = ev as EventOf<"sandbox_log">;
        const h = holder(e.exp_id);
        h.logs.push(...strings(e.lines));
        if (h.logs.length > MAX_LOG_LINES) h.logs.splice(0, h.logs.length - MAX_LOG_LINES);
        break;
      }
      case "hpo_trial": {
        const e = ev as EventOf<"hpo_trial">;
        const x = byId.get(e.exp_id);
        if (x) x.hpoTrials++;
        else holder(e.exp_id).hpo++;
        break;
      }
      case "report_ready": {
        const e = ev as EventOf<"report_ready">;
        const r = (e.report ?? {}) as Record<string, unknown>;
        out.push({
          kind: "report",
          key: `report-${e.seq}`,
          seq: e.seq,
          plain: str(r.plain),
          summary: str(r.summary),
          whatWorked: strings(r.what_worked),
          caveats: strings(r.caveats),
          nextSteps: strings(r.next_steps),
        });
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
            newBest: e.best_exp_id === e.exp_id && isNewBest(e.decision, e.reason),
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
  const tail =
    last.kind === "experiment"
      ? `${last.stage}:${last.attempts.length}:${last.llmCalls}:${last.steps.length}:${last.steps.filter((x) => x.running).length}:${last.logs.length}:${last.hpoTrials}`
      : last.kind === "agent_step"
        ? `step:${last.running}`
        : last.kind;
  return `${items.length}:${tail}`;
}

/** The newest agent step that has started but not finished, wherever it lives (null when none or for legacy runs). */
export function activeAgentStep(events: readonly AnyEvent[]): { role: string; expId: string | null } | null {
  const open = new Map<string, { role: string; expId: string | null }>();
  for (const ev of events) {
    if (ev.type === "agent_step_started") {
      const e = ev as EventOf<"agent_step_started">;
      open.delete(e.step_id);
      open.set(e.step_id, { role: e.role, expId: e.exp_id ?? null });
    } else if (ev.type === "agent_step_finished") {
      open.delete((ev as EventOf<"agent_step_finished">).step.step_id ?? "");
    }
  }
  return [...open.values()].at(-1) ?? null;
}

/** "planner" -> "Planner", "hpo_tuner" -> "Hpo tuner". */
export function roleLabel(role: string): string {
  const r = role.replace(/[_-]+/g, " ").trim();
  return r ? r[0].toUpperCase() + r.slice(1) : "Agent";
}

/** The experiment still in flight (the "typing" message), if any. */
export function inFlight(items: readonly FeedItem[]): ExperimentItem | null {
  const last = items.at(-1);
  return last?.kind === "experiment" && last.stage !== "decided" ? last : null;
}

const DOING: Record<string, string> = {
  intake: "is reading your data",
  profiler: "is profiling the data",
  planner: "is choosing the next idea",
  coder: "is writing the code",
  executor: "is running the code in the sandbox",
  debugger: "is fixing the code",
  critic: "is checking the result for leaks",
  judge: "is giving a second opinion",
  tuner: "is setting up a hyperparameter search",
  ensembler: "is blending the best models",
  reporter: "is writing the report",
};

/** "Planner is choosing the next idea" — the one-line status for a running step. */
export function roleDoing(role: string): string {
  return `${roleLabel(role)} ${DOING[role] ?? "is working"}`;
}
