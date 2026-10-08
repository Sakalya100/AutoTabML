/**
 * The session chat: one pure reducer turns a session's runs (their event streams) and its stored messages into the
 * chat timeline: one Task card for the setup (intake + profiler steps), one card per experiment (its agent steps and the
 * gate's verdict), a quiet phase label ("Drafts · 3") where the experiments' phase changes, then the stop, the locked
 * test, the report and the run's assets (charts and files).
 *
 * Pure and O(events + messages), so a reload rebuilds exactly what a live viewer saw.
 */
import { parseAssetsEvent, type AssetChart, type AssetFile, type CvPoint } from "./assets";
import { isAssetsReady, type AnyEvent, type EventOf } from "./events";
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
  /** Intake and profiler steps (the setup), shown as step lines in the Task card. */
  steps: ChatStep[];
  /** The user's own goal text, when they gave one. */
  description: string | null;
  target: string | null;
  problemType: string | null;
  metric: Metric | null;
  nRows: number | null;
  nCols: number | null;
  maxExperiments: number | null;
  warnings: string[];
}

export interface ChatAssets {
  kind: "assets";
  key: string;
  ts: string;
  runId: string;
  /** From assets_ready (empty until it arrives). */
  charts: AssetChart[];
  files: AssetFile[];
  /** Every scored experiment, for the "CV score per experiment" chart. */
  cv: CvPoint[];
  /** assets_ready has arrived (otherwise only the CV chart is shown). */
  ready: boolean;
}

export type ChatItem =
  | { kind: "phase"; key: string; ts: string; runId: string; stage: Stage; label: string; count: number }
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
      /** All of the run's LLM tokens, for the equivalent cost (set after every event is read). */
      tokensIn: number;
      tokensOut: number;
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
  | ChatAssets
  | { kind: "run_end"; key: string; ts: string; runId: string; status: "failed" | "cancelled" | "timed_out"; error: string | null };

export interface ChatRunInput {
  id: string;
  events: readonly AnyEvent[];
  /** Run status from the API; failed/cancelled/timed_out adds a closing message. */
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
/** Run-level roles whose steps fold into the Task card. */
const SETUP_ROLES = new Set(["intake", "profiler"]);
/** Stages that get a phase label above their experiments. */
const EXP_STAGES = new Set<Stage>(["baseline", "drafts", "improve", "tuning", "ensemble"]);
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

/** Fold one run's events into chat items (with phase labels and the assets card). */
export function runItems(run: ChatRunInput): ChatItem[] {
  const items: ChatItem[] = [];
  const exps = new Map<string, ChatExperiment & { phase: string | null }>();
  const stepOwner = new Map<string, ChatStep>(); // step_id -> step (experiment or run-level)
  const rid = run.id;
  let lastTs = "";
  let task: ChatTask | null = null;
  let assets: { charts: AssetChart[]; files: AssetFile[]; ts: string } | null = null;
  let terminal = run.status === "finished" || run.status === "failed" || run.status === "cancelled" || run.status === "timed_out";

  // The Task card appears with whichever comes first: run_started or the intake/profiler step.
  const taskItem = (ts: string): ChatTask => {
    if (!task) {
      task = {
        kind: "task",
        key: `${rid}:task`,
        ts,
        runId: rid,
        steps: [],
        description: null,
        target: null,
        problemType: null,
        metric: null,
        nRows: null,
        nCols: null,
        maxExperiments: null,
        warnings: [],
      };
      items.push(task);
    }
    return task;
  };
  const addRunStep = (st: ChatStep, ts: string, seq: number) => {
    if (SETUP_ROLES.has(st.role)) taskItem(ts).steps.push(st);
    else items.push({ kind: "step", key: `${rid}:step:${st.stepId || seq}`, ts, runId: rid, stage: RUN_STAGE[st.role] ?? "profiling", step: st });
  };

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
        const intake = (cfg.intake ?? {}) as Record<string, unknown>;
        const max = cfg.max_experiments ?? stopRule.max_experiments ?? agentic.max_experiments;
        const warnings = [...strings(e.profile?.warnings), ...strings(intake.warnings)];
        Object.assign(taskItem(e.ts), {
          description: str((e.task as { description?: unknown } | undefined)?.description),
          target: e.profile?.target ?? e.task?.target ?? null,
          problemType: e.profile?.problem_type ?? (e.task as { problem_type?: string } | undefined)?.problem_type ?? null,
          metric: e.profile?.metric ?? e.task?.metric ?? null,
          nRows: e.profile?.n_rows ?? null,
          nCols: e.profile?.n_cols ?? null,
          maxExperiments: typeof max === "number" ? max : null,
          warnings: [...new Set(warnings)],
        } satisfies Partial<ChatTask>);
        break;
      }
      case "agent_step_started": {
        const e = ev as EventOf<"agent_step_started">;
        const st = { ...emptyStep(e.step_id, e.role), attempt: e.attempt ?? 0, inputSummary: e.input_summary ?? "" };
        stepOwner.set(e.step_id, st);
        if (e.exp_id) experiment(e.exp_id, e.ts).steps.push(st);
        else addRunStep(st, e.ts, e.seq);
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
          else addRunStep(st, e.ts, e.seq);
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
        terminal = true;
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
          tokensIn: 0,
          tokensOut: 0,
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
        terminal = true;
        break;
      }
      default:
        if (isAssetsReady(ev)) {
          assets = { ...parseAssetsEvent(ev), ts: ev.ts };
          terminal = true;
        }
    }
  }

  for (const x of exps.values()) x.stage = experimentStage(x, x.phase);
  // The final card counts every LLM call of the run, the Reporter's (which come after run_finished) included.
  let tokIn = 0;
  let tokOut = 0;
  for (const e of run.events) {
    if (e.type !== "llm_call") continue;
    tokIn += e.usage?.input_tokens ?? 0;
    tokOut += e.usage?.output_tokens ?? 0;
  }
  for (const it of items) {
    if (it.kind !== "final") continue;
    it.tokensIn = tokIn;
    it.tokensOut = tokOut;
  }

  if (run.status === "failed" || run.status === "cancelled" || run.status === "timed_out")
    items.push({ kind: "run_end", key: `${rid}:end`, ts: run.finishedAt ?? lastTs ?? "", runId: rid, status: run.status, error: run.error ?? null });

  // The report message carries the Reporter's headline; its finished step line would only repeat it.
  const hasReport = items.some((it) => it.kind === "report");
  const shown = hasReport ? items.filter((it) => !(it.kind === "step" && it.step.role === "reporter" && it.step.status === "ok")) : items;

  // The assets card (charts + files), once the run is over: right after the report, else after the locked test,
  // else last (before a failed/cancelled run's closing message).
  const cv: CvPoint[] = [...exps.values()]
    .filter((x) => x.scored)
    .map((x) => ({ id: x.id, mean: x.scored!.cvMean, se: x.scored!.cvSe, verdict: x.decision?.verdict ?? null, best: false }));
  const lastBest = [...exps.values()].reverse().find((x) => x.decision)?.decision?.bestId;
  for (const p of cv) p.best = p.id === lastBest;
  const got = assets as { charts: AssetChart[]; files: AssetFile[]; ts: string } | null;
  if (terminal && (got || cv.length)) {
    const at = Math.max(
      shown.findIndex((it) => it.kind === "report"),
      shown.findIndex((it) => it.kind === "final"),
    );
    const endAt = shown.findIndex((it) => it.kind === "run_end");
    const pos = at >= 0 ? at + 1 : endAt >= 0 ? endAt : shown.length;
    const ts = got?.ts ?? shown[pos - 1]?.ts ?? lastTs;
    shown.splice(pos, 0, { kind: "assets", key: `${rid}:assets`, ts, runId: rid, charts: got?.charts ?? [], files: got?.files ?? [], cv, ready: !!got });
  }

  // A quiet phase label above each run of experiments in the same phase ("Drafts · 3").
  const out: ChatItem[] = [];
  let stage: Stage | null = null;
  let label: Extract<ChatItem, { kind: "phase" }> | null = null;
  for (const it of shown) {
    if (it.kind === "experiment" && EXP_STAGES.has(it.stage)) {
      if (it.stage !== stage || !label) {
        stage = it.stage;
        label = {
          kind: "phase",
          key: `${rid}:phase:${out.length}:${it.stage}`,
          ts: it.ts,
          runId: rid,
          stage: it.stage,
          label: STAGE_LABEL[it.stage],
          count: 0,
        };
        out.push(label);
      }
      label.count++;
    }
    out.push(it);
  }
  return out;
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
  if (last.kind === "task") return `${items.length}:task:${last.steps.length}:${last.steps.filter((s) => s.status === "running").length}`;
  if (last.kind === "assets") return `${items.length}:assets:${last.charts.length}:${last.files.length}:${last.ready}`;
  return `${items.length}:${last.kind}`;
}
