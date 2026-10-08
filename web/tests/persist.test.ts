import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { EventSink, runPatchFromEvents } from "@/lib/db/persist";
import { INSERT_EVENTS_SQL } from "@/lib/db/repo";
import type { AnyEvent } from "@/lib/events";

/** An in-memory stand-in for the two statements the sink issues (event insert, run update). */
class FakeDb implements Db {
  rows = new Map<string, { type: string; payload: unknown }>();
  runs = new Map<string, Record<string, unknown>>([["r-known01", {}]]);
  calls = 0;
  failNext: unknown = null;
  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    this.calls++;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    if (text === INSERT_EVENTS_SQL) {
      const [runIds, seqs, types, payloads] = params as [string[], number[], string[], string[]];
      runIds.forEach((r, i) => {
        if (!this.runs.has(r)) throw Object.assign(new Error("fk"), { code: "23503" });
        const key = `${r}:${seqs[i]}`;
        if (!this.rows.has(key)) this.rows.set(key, { type: types[i], payload: JSON.parse(payloads[i]) }); // on conflict do nothing
      });
      return [];
    }
    if (text.startsWith("update runs set")) {
      const run = this.runs.get(params[0] as string);
      if (run) Object.assign(run, { last: text, params: params.slice(1) });
      return [];
    }
    return [];
  }
}

const ev = (seq: number, type = "sandbox_log", extra: Record<string, unknown> = {}): AnyEvent =>
  ({ run_id: "x", seq, ts: "2026-10-08T10:00:00Z", type, exp_id: "e001", lines: ["hi"], ...extra }) as unknown as AnyEvent;

describe("event persistence", () => {
  it("batches and is idempotent on (run_id, seq)", async () => {
    const db = new FakeDb();
    const sink = new EventSink(() => db, { flushMs: 5 });
    sink.enqueue("r-known01", [ev(1), ev(2), ev(3)]);
    sink.enqueue("r-known01", [ev(2), ev(3), ev(4)]); // a retried / duplicated delivery
    await sink.flush("r-known01");
    sink.enqueue("r-known01", [ev(1), ev(4), ev(5)]);
    await sink.flush("r-known01");
    expect([...db.rows.keys()].sort()).toEqual(["r-known01:1", "r-known01:2", "r-known01:3", "r-known01:4", "r-known01:5"]);
  });

  it("skips runs the database doesn't know (legacy / created while it was down)", async () => {
    const db = new FakeDb();
    const sink = new EventSink(() => db, { flushMs: 5 });
    sink.enqueue("r-unknown1", [ev(1)]);
    await sink.flush("r-unknown1");
    const calls = db.calls;
    sink.enqueue("r-unknown1", [ev(2)]);
    await sink.flush("r-unknown1");
    expect(db.calls).toBe(calls); // never retried
    expect(db.rows.size).toBe(0);
  });

  it("retries a transient failure without losing or duplicating events", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = new FakeDb();
    const sink = new EventSink(() => db, { flushMs: 5 });
    db.failNext = new TypeError("fetch failed");
    sink.enqueue("r-known01", [ev(1), ev(2)]);
    await sink.flush("r-known01"); // fails, keeps the batch
    expect(db.rows.size).toBe(0);
    await sink.flush("r-known01");
    expect(db.rows.size).toBe(2);
    warn.mockRestore();
  });

  it("does nothing without a database", () => {
    const sink = new EventSink(() => null);
    expect(() => sink.enqueue("r-known01", [ev(1)])).not.toThrow();
  });

  it("derives the run row's best, stop, final and report from events", () => {
    const p = runPatchFromEvents([
      ev(1, "decision", { decision: "keep", best_exp_id: "e001", best_cv_mean: 0.81, reason: "" }),
      ev(2, "stopped", { reason: "user", summary: "stopped by the user after e003", report: {} }),
      ev(3, "run_finished", { best_exp_id: "e001", dev_cv_mean: 0.82, select_score: 0.8, test_score: 0.79, optimism_gap: 0.01, n_experiments: 4, total_cost_usd: 0, wall_time_s: 99 }),
      ev(4, "report_ready", { report: { plain: "Found a model.", summary: "s", numbers: {} } }),
    ]);
    expect(p.best).toBe(0.82);
    expect(p.summary).toMatchObject({ stop: { reason: "user" }, final: { test_score: 0.79 }, report: { plain: "Found a model." } });
  });
});
