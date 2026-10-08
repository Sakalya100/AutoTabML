/**
 * Batched, idempotent persistence of run events (and the run row's status/best/summary) to Postgres.
 *
 * The live path (file store / Redis → SSE) never waits on this: `enqueue` returns immediately, a timer flushes every
 * FLUSH_MS (or at MAX_BATCH events), and `flush(runId)` drains a run before it is marked terminal. Inserts are
 * `on conflict (run_id, seq) do nothing`, so retries and duplicate deliveries are harmless.
 *
 * Failure policy: a run that is not in the `runs` table (FK violation: a legacy run, or one started while the DB was
 * down) is skipped from then on. Any other failure keeps the batch for a few retries, then drops it; the first
 * failure is logged once (dbFailed). A run never fails because of the database.
 */
import type { AnyEvent, EventOf } from "../events";
import { dbFailed, dbRecovered, pgCode, type Db } from "./client";
import { insertEvents, updateRun, type RunPatch } from "./repo";

const FLUSH_MS = 400;
const MAX_BATCH = 200;
const MAX_RETRIES = 4;

interface Pending {
  events: AnyEvent[];
  patch: RunPatch;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
}

/** What an event batch changes on the run row (best score, final numbers, stop reason, report headline). */
export function runPatchFromEvents(events: readonly AnyEvent[]): RunPatch {
  const patch: RunPatch = {};
  const summary: Record<string, unknown> = {};
  for (const ev of events) {
    if (ev.type === "decision") patch.best = (ev as EventOf<"decision">).best_cv_mean;
    else if (ev.type === "stopped") {
      const e = ev as EventOf<"stopped">;
      summary.stop = { reason: e.reason, summary: e.summary };
    } else if (ev.type === "run_finished") {
      const e = ev as EventOf<"run_finished">;
      patch.best = e.dev_cv_mean;
      summary.final = {
        best_exp_id: e.best_exp_id,
        dev_cv_mean: e.dev_cv_mean,
        select_score: e.select_score,
        test_score: e.test_score,
        optimism_gap: e.optimism_gap,
        n_experiments: e.n_experiments,
        total_cost_usd: e.total_cost_usd,
        wall_time_s: e.wall_time_s,
      };
    } else if (ev.type === "report_ready") {
      const r = ((ev as EventOf<"report_ready">).report ?? {}) as Record<string, unknown>;
      summary.report = { plain: r.plain ?? null, summary: r.summary ?? null };
    } else if (ev.type === "run_started") {
      const e = ev as EventOf<"run_started">;
      summary.task = { metric: e.profile?.metric ?? null, problem_type: e.profile?.problem_type ?? null, n_rows: e.profile?.n_rows ?? null };
    }
  }
  if (Object.keys(summary).length) patch.summary = summary;
  return patch;
}

function mergePatch(a: RunPatch, b: RunPatch): RunPatch {
  return {
    ...a,
    ...b,
    ...(a.summary || b.summary ? { summary: { ...(a.summary ?? {}), ...(b.summary ?? {}) } } : {}),
  };
}

export class EventSink {
  private pending = new Map<string, Pending>();
  /** Runs the database doesn't know (FK violation): never retried. */
  private skipped = new Set<string>();

  constructor(
    private readonly db: () => Db | null,
    private readonly opts: { flushMs?: number; maxBatch?: number } = {},
  ) {}

  private slot(runId: string): Pending {
    let p = this.pending.get(runId);
    if (!p) this.pending.set(runId, (p = { events: [], patch: {}, retries: 0, timer: null, inflight: null }));
    return p;
  }

  enqueue(runId: string, events: readonly AnyEvent[], patch: RunPatch = {}): void {
    if (this.skipped.has(runId) || (!events.length && !Object.keys(patch).length)) return;
    if (!this.db()) return;
    const p = this.slot(runId);
    p.events.push(...events);
    p.patch = mergePatch(mergePatch(p.patch, runPatchFromEvents(events)), patch);
    if (p.events.length >= (this.opts.maxBatch ?? MAX_BATCH)) void this.flush(runId);
    else if (!p.timer) p.timer = setTimeout(() => void this.flush(runId), this.opts.flushMs ?? FLUSH_MS);
  }

  /** Write everything queued for `runId` (waits for an in-flight write first). */
  async flush(runId: string): Promise<void> {
    const p = this.pending.get(runId);
    if (!p) return;
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
    while (p.inflight) await p.inflight;
    if (!p.events.length && !Object.keys(p.patch).length) return;
    const events = p.events.splice(0, p.events.length);
    const patch = p.patch;
    p.patch = {};
    p.inflight = this.write(runId, events, patch).finally(() => {
      p.inflight = null;
    });
    await p.inflight;
    if (p.events.length || Object.keys(p.patch).length) {
      if (!p.timer) p.timer = setTimeout(() => void this.flush(runId), this.opts.flushMs ?? FLUSH_MS);
    } else if (!p.timer) this.pending.delete(runId);
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((id) => this.flush(id)));
  }

  private async write(runId: string, events: AnyEvent[], patch: RunPatch): Promise<void> {
    const db = this.db();
    if (!db) return;
    try {
      await insertEvents(db, runId, events);
      await updateRun(db, runId, patch);
      dbRecovered();
      const p = this.pending.get(runId);
      if (p) p.retries = 0;
    } catch (err) {
      if (pgCode(err) === "23503") {
        this.skipped.add(runId); // not a database-backed run
        return;
      }
      dbFailed(err, "event persistence");
      const p = this.slot(runId);
      if (++p.retries <= MAX_RETRIES) {
        p.events.unshift(...events);
        p.patch = mergePatch(patch, p.patch);
      }
    }
  }
}
