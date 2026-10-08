/**
 * The session chat: one pure reducer turns a session's runs (their event streams) and its stored messages into the
 * chat timeline. Every agent step becomes a message; steps are grouped per experiment with the gate's verdict; stage
 * dividers mark Intake → Profiling → Baseline → Drafts → Improve → Tuning → Ensemble → Stop → Locked test → Report.
 *
 * Pure and O(events + messages), so a reload rebuilds exactly what a live viewer saw.
 */
import type { AnyEvent, EventOf } from "./events";
import { parseGateReason, type GateSummary } from "./feed";
import type { Decision, Idea, Metric } from "./schema";

export type Stage = "intake" | "profiling" | "baseline" | "drafts" | "improve" | "tuning" | "ensemble" | "stop" | "locked_test" | "report";

export const STAGE_LABEL: Record<Stage, string> = {
  intake: "Intake",
  profiling: "Profiling",
  baseline: "Baseline",
  drafts: "Drafts",
  improve: "Improve",
  tuning: "Tuning",
  ensemble: "Ensemble",
  stop: "Stop",
  locked_test: "Locked test",
  report: "Report",
};

/** One agent step, with everything the disclosure shows. */
export interface ChatStep {
  stepId: string;
  role: string;
  status: "running" | "ok" | "error";
  plain: string;
  inputSummary: string;
  model: string | null;
  provider: string | null;
  attempt: number;
  /** Streamed reasoning while running (agent_reasoning), or the finished step's reasoning. */
  reasoning: string | null;
  code: string | null;
  diff: string | null;
  stdoutTail: string | null;
  stderrTail: string | null;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  wouldBeCostUsd: number;
  durationS: number;
}

export interface ChatExperiment {
  kind: "experiment";
  key: string;
  ts: string;
  runId: string;
  id: string;
  /** 0-based order within the run (the ball position). */
  index: number;
  stage: Stage;
  /** Null until experiment_started arrives (the Planner runs before it). */
  idea: Idea | null;
  steps: ChatStep[];
  logs: string[];
  hpoTrials: number;
  attempts: { attempt: number; ok: boolean; errorKind: string | null }[];
  scored: { cvMean: number; cvSe: number; select: number } | null;
  decision: { verdict: Decision; reason: string; gate: GateSummary; newBest: boolean; bestId: string; bestMean: number } | null;
}

export interface ChatTask {
  kind: "task";
  key: string;
  ts: string;
  runId: string;
  target: string | null;
  problemType: string | null;
  metric: Metric | null;
  nRows: number | null;
  nCols: number | null;
  maxExperiments: number | null;
  warnings: string[];
}

export type ChatItem =
  | { kind: "divider"; key: string; ts: string; runId: string; stage: Stage; label: string }
  | { kind: "user"; key: string; ts: string; id: string; text: string; msgKind: "chat" | "steer" | "control"; pending?: boolean }
  | { kind: "system"; key: string; ts: string; text: string; tone: "info" | "warn" }
  | ChatTask
  | { kind: "step"; key: string; ts: string; runId: string; stage: Stage; step: ChatStep }
  | ChatExperiment
  | { kind: "steer_ack"; key: string; ts: string; runId: string; text: string; atExp: string | null }
  | { kind: "stopped"; key: string; ts: string; runId: string; reason: string; summary: string }
  | {
      kind: "final";
      key: string;
      ts: string;
      runId: string;
      bestId: string;
      devCvMean: number;
      select: number;
      test: number;
      gap: number;
      nExperiments: number;
      costUsd: number;
      wallTimeS: number;
    }
  | {
      kind: "report";
      key: string;
      ts: string;
      runId: string;
      plain: string | null;
      summary: string | null;
      whatWorked: string[];
      caveats: string[];
      nextSteps: string[];
      notes: string[];
      faithful: boolean | null;
    }
  | { kind: "run_end"; key: string; ts: string; runId: string; status: "failed" | "cancelled"; error: string | null };

export interface ChatRunInput {
  id: string;
  events: readonly AnyEvent[];
  /** Run status from the store/DB; failed/cancelled adds a closing message. */
  status?: string | null;
  error?: string | null;
  finishedAt?: string | null;
}

export interface ChatMessageInput {
  id: string;
  role: "user" | "system";
  text: string;
  kind: "chat" | "steer" | "control";
  created_at: string;
  pending?: boolean;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const RUN_STAGE: Record<string, Stage> = { intake: "intake", profiler: "profiling", reporter: "report" };
const PHASE_STAGE: Record<string, Stage> = { baseline: "baseline", draft: "drafts", improve: "improve", tune: "tuning", ensemble: "ensemble" };

/** The stage an experiment belongs to: the engine's `phase` when present, else inferred from its steps. */
export function experimentStage(x: Pick<ChatExperiment, "index" | "steps" | "idea">, phase?: string | null): Stage {
  if (phase && PHASE_STAGE[phase]) return PHASE_STAGE[phase];
  const roles = new Set(x.steps.map((s) => s.role));
  if (roles.has("tuner")) return "tuning";
  if (roles.has("ensembler")) return "ensemble";
  const planner = x.steps.find((s) => s.role === "planner");
  if (planner?.inputSummary.startsWith("draft")) return "drafts";
  if (planner?.inputSummary.startsWith("improve")) return "improve";
  if (x.index === 0 || x.idea?.category === "baseline") return "baseline";
  return x.idea?.radical ? "drafts" : "improve";
}

function emptyStep(stepId: string, role: string): ChatStep {
  return {
    stepId,
    role,
    status: "running",
    plain: "",
    inputSummary: "",
    model: null,
    provider: null,
    attempt: 0,
    reasoning: null,
    code: null,
    diff: null,
    stdoutTail: null,
    stderrTail: null,
    error: null,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    costUsd: 0,
    wouldBeCostUsd: 0,
    durationS: 0,
  };
}

/** Fold one run's events into chat items (with stage dividers). */
export function runItems(run: ChatRunInput): ChatItem[] {
  const items: ChatItem[] = [];
  const exps = new Map<string, ChatExperiment & { phase: string | null }>();
  const runSteps = new Map<string, ChatStep>();
  const stepOwner = new Map<string, ChatStep>(); // step_id -> step (experiment or run-level)
  const rid = run.id;
  let lastTs = "";

  const experiment = (expId: string, ts: string) => {
    let x = exps.get(expId);
    if (!x) {
      x = {
        kind: "experiment",
        key: `${rid}:exp:${expId}`,
        ts,
        runId: rid,
        id: expId,
        index: exps.size,
        stage: "improve",
        phase: null,
        idea: null,
        steps: [],
        logs: [],
        hpoTrials: 0,
        attempts: [],
        scored: null,
        decision: null,
      };
      exps.set(expId, x);
      items.push(x);
    }
    return x;
  };

  for (const ev of run.events) {
    lastTs = ev.ts;
    switch (ev.type) {
      case "run_started": {
        const e = ev as EventOf<"run_started">;
        const cfg = (e.config ?? {}) as Record<string, unknown>;
        const stopRule = (cfg.stop_rule ?? {}) as Record<string, unknown>;
        const agentic = (cfg.agentic ?? {}) as Record<string, unknown>;
        const max = cfg.max_experiments ?? stopRule.max_experiments ?? agentic.max_experiments;
        items.push({
          kind: "task",
          key: `${rid}:task`,
          ts: e.ts,
          runId: rid,
          target: e.profile?.target ?? e.task?.target ?? null,
          problemType: e.profile?.problem_type ?? null,
          metric: e.profile?.metric ?? e.task?.metric ?? null,
          nRows: e.profile?.n_rows ?? null,
          nCols: e.profile?.n_cols ?? null,
          maxExperiments: typeof max === "number" ? max : null,
          warnings: e.profile?.warnings ?? [],
        });
        break;
      }
      case "agent_step_started": {
        const e = ev as EventOf<"agent_step_started">;
        const st = { ...emptyStep(e.step_id, e.role), attempt: e.attempt ?? 0, inputSummary: e.input_summary ?? "" };
        stepOwner.set(e.step_id, st);
        if (e.exp_id) experiment(e.exp_id, e.ts).steps.push(st);
        else {
          runSteps.set(e.step_id, st);
          items.push({ kind: "step", key: `${rid}:step:${e.step_id || e.seq}`, ts: e.ts, runId: rid, stage: RUN_STAGE[e.role] ?? "profiling", step: st });
        }
        break;
      }
      case "agent_reasoning": {
        const e = ev as EventOf<"agent_reasoning">;
        const st = stepOwner.get(e.step_id);
        if (st) st.reasoning = e.text;
        break;
      }
      case "agent_step_finished": {
        const e = ev as EventOf<"agent_step_finished">;
        const s = e.step;
        const id = s.step_id ?? "";
        let st = id ? stepOwner.get(id) : undefined;
        if (!st) {
          st = emptyStep(id, s.role);
          if (id) stepOwner.set(id, st);
          if (e.exp_id) experiment(e.exp_id, e.ts).steps.push(st);
          else items.push({ kind: "step", key: `${rid}:step:${id || e.seq}`, ts: e.ts, runId: rid, stage: RUN_STAGE[s.role] ?? "profiling", step: st });
        }
        Object.assign(st, {
          role: s.role,
          status: s.status === "error" ? "error" : "ok",
          plain: s.plain ?? "",
          inputSummary: s.input_summary || st.inputSummary,
          model: s.model ?? null,
          provider: s.provider ?? null,
          attempt: s.attempt ?? 0,
          reasoning: s.reasoning ?? st.reasoning,
          code: s.code ?? null,
          diff: s.diff ?? null,
          stdoutTail: s.stdout_tail ?? null,
          stderrTail: s.stderr_tail ?? null,
          error: s.error ?? null,
          tokensIn: s.tokens_in ?? 0,
          tokensOut: s.tokens_out ?? 0,
          tokensCached: s.tokens_cached ?? 0,
          costUsd: s.cost_usd ?? 0,
          wouldBeCostUsd: s.would_be_cost_usd ?? 0,
          durationS: s.duration_s ?? 0,
        } satisfies Partial<ChatStep>);
        break;
      }
      case "experiment_started": {
        const e = ev as EventOf<"experiment_started">;
        const x = experiment(e.exp_id, e.ts);
        x.idea = e.idea;
        x.phase = (e as { phase?: string | null }).phase ?? null;
        break;
      }
      case "sandbox_log": {
        const e = ev as EventOf<"sandbox_log">;
        const x = experiment(e.exp_id, e.ts);
        x.logs.push(...strings(e.lines));
        if (x.logs.length > 200) x.logs.splice(0, x.logs.length - 200);
        break;
      }
      case "hpo_trial":
        experiment((ev as EventOf<"hpo_trial">).exp_id, ev.ts).hpoTrials++;
        break;
      case "sandbox_finished": {
        const e = ev as EventOf<"sandbox_finished">;
        experiment(e.exp_id, e.ts).attempts.push({ attempt: e.attempt, ok: e.ok, errorKind: e.error_kind ?? null });
        break;
      }
      case "experiment_scored": {
        const e = ev as EventOf<"experiment_scored">;
        experiment(e.exp_id, e.ts).scored = { cvMean: e.cv.mean, cvSe: e.cv.se, select: e.select_score };
        break;
      }
      case "decision": {
        const e = ev as EventOf<"decision">;
        experiment(e.exp_id, e.ts).decision = {
          verdict: e.decision,
          reason: e.reason ?? "",
          gate: parseGateReason(e.reason),
          newBest: e.decision === "keep" && e.best_exp_id === e.exp_id,
          bestId: e.best_exp_id,
          bestMean: e.best_cv_mean,
        };
        break;
      }
      case "steer_applied": {
        const e = ev as EventOf<"steer_applied">;
        items.push({ kind: "steer_ack", key: `${rid}:steer:${e.seq}`, ts: e.ts, runId: rid, text: e.text, atExp: e.at_exp ?? null });
        break;
      }
      case "stopped": {
        const e = ev as EventOf<"stopped">;
        items.push({ kind: "stopped", key: `${rid}:stop`, ts: e.ts, runId: rid, reason: e.reason, summary: e.summary });
        break;
      }
      case "run_finished": {
        const e = ev as EventOf<"run_finished">;
        items.push({
          kind: "final",
          key: `${rid}:final`,
          ts: e.ts,
          runId: rid,
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
      case "report_ready": {
        const e = ev as EventOf<"report_ready">;
        const r = (e.report ?? {}) as Record<string, unknown>;
        const checks = (r.checks ?? {}) as Record<string, unknown>;
        items.push({
          kind: "report",
          key: `${rid}:report`,
          ts: e.ts,
          runId: rid,
          plain: str(r.plain),
          summary: str(r.summary),
          whatWorked: strings(r.what_worked),
          caveats: strings(r.caveats),
          nextSteps: strings(r.next_steps),
          notes: strings(r.notes),
          faithful: typeof checks.faithful === "boolean" ? checks.faithful : null,
        });
        break;
      }
    }
  }

  for (const x of exps.values()) x.stage = experimentStage(x, x.phase);

  if (run.status === "failed" || run.status === "cancelled")
    items.push({ kind: "run_end", key: `${rid}:end`, ts: run.finishedAt ?? lastTs ?? "", runId: rid, status: run.status, error: run.error ?? null });

  // The report message carries the Reporter's headline; its finished step line would only repeat it.
  const hasReport = items.some((it) => it.kind === "report");
  const shown = hasReport ? items.filter((it) => !(it.kind === "step" && it.step.role === "reporter" && it.step.status === "ok")) : items;

  // Stage dividers: one whenever the stage changes along the run.
  const out: ChatItem[] = [];
  let stage: Stage | null = null;
  for (const it of shown) {
    const s = itemStage(it);
    if (s && s !== stage) {
      stage = s;
      out.push({ kind: "divider", key: `${rid}:div:${out.length}:${s}`, ts: it.ts, runId: rid, stage: s, label: STAGE_LABEL[s] });
    }
    out.push(it);
  }
  return out;
}

function itemStage(it: ChatItem): Stage | null {
  switch (it.kind) {
    case "task":
      return "intake";
    case "step":
    case "experiment":
      return it.stage;
    case "stopped":
      return "stop";
    case "final":
      return "locked_test";
    case "report":
      return "report";
    default:
      return null;
  }
}

/**
 * The whole session: every run's items and the stored messages, merged by time (stable, so a run's own order is kept
 * and a message lands right after whatever was on screen when it was sent).
 */
export function buildChat(runs: readonly ChatRunInput[], messages: readonly ChatMessageInput[]): ChatItem[] {
  const runBlocks = runs.map(runItems);
  const msgs: ChatItem[] = messages.map((m) =>
    m.role === "user"
      ? { kind: "user", key: `msg:${m.id}`, ts: m.created_at, id: m.id, text: m.text, msgKind: m.kind, pending: m.pending }
      : { kind: "system", key: `msg:${m.id}`, ts: m.created_at, text: m.text, tone: m.kind === "control" || m.kind === "steer" ? "warn" : "info" },
  );
  // Merge: walk all run items in run order; a message goes before the first run item that is later than it.
  const stream = runBlocks.flat();
  const t = (s: string) => {
    const v = Date.parse(s);
    return Number.isFinite(v) ? v : 0;
  };
  // Messages keep their own order; run blocks keep theirs (runs are created in order).
  const sortedMsgs = [...msgs].sort((a, b) => t(a.ts) - t(b.ts));
  const out: ChatItem[] = [];
  let i = 0;
  for (const it of stream) {
    while (i < sortedMsgs.length && t(sortedMsgs[i].ts) <= t(it.ts)) out.push(sortedMsgs[i++]);
    out.push(it);
  }
  while (i < sortedMsgs.length) out.push(sortedMsgs[i++]);
  return out;
}

/** Changes whenever something visible changes (drives auto-scroll and the "new" pill). */
export function chatSignature(items: readonly ChatItem[]): string {
  const last = items.at(-1);
  if (!last) return "0";
  if (last.kind === "experiment")
    return `${items.length}:${last.steps.length}:${last.steps.filter((s) => s.status === "running").length}:${last.logs.length}:${last.decision?.verdict ?? ""}:${last.attempts.length}`;
  if (last.kind === "step") return `${items.length}:${last.step.status}`;
  return `${items.length}:${last.kind}`;
}
