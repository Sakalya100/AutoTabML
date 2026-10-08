/**
 * Wraps the live store (file / Redis) and mirrors every event and status change into Postgres.
 *
 * Reads and live tailing still come from the wrapped store; Postgres is the durable history behind sessions. Writes
 * to Postgres are batched and never block or fail the live path (see db/persist.ts). Before a run is marked terminal
 * its queued events are flushed, so a reload right after the end shows the whole run.
 */
import type { AnyEvent } from "../events";
import type { EventSink } from "../db/persist";
import type { RunRecord } from "../schema";
import { isTerminal, type RunMeta, type Store } from "./types";

export class PersistingStore implements Store {
  constructor(
    readonly inner: Store,
    readonly sink: EventSink,
  ) {}

  get kind() {
    return this.inner.kind;
  }

  createRun(meta: RunMeta): Promise<void> {
    return this.inner.createRun(meta);
  }

  getMeta(id: string): Promise<RunMeta | null> {
    return this.inner.getMeta(id);
  }

  async updateMeta(id: string, patch: Partial<RunMeta>): Promise<RunMeta | null> {
    if (patch.status && isTerminal(patch.status)) {
      try {
        await this.sink.flush(id);
      } catch {}
    }
    const next = await this.inner.updateMeta(id, patch);
    if (patch.status) {
      const summary = patch.error ? { error: patch.error } : undefined;
      this.sink.enqueue(id, [], {
        status: patch.status,
        ...(patch.finishedAt ? { finishedAt: patch.finishedAt } : {}),
        ...(summary ? { summary } : {}),
      });
      if (isTerminal(patch.status)) await this.sink.flush(id).catch(() => undefined);
    }
    return next;
  }

  async appendEvents(id: string, events: AnyEvent[]): Promise<number> {
    const n = await this.inner.appendEvents(id, events);
    // All of them, not only the `n` new ones: inserts are idempotent and this also heals a batch the DB missed.
    this.sink.enqueue(id, events);
    return n;
  }

  readEvents(id: string, afterSeq?: number): Promise<AnyEvent[]> {
    return this.inner.readEvents(id, afterSeq);
  }

  putRecord(id: string, record: RunRecord): Promise<void> {
    return this.inner.putRecord(id, record);
  }

  getRecord(id: string): Promise<RunRecord | null> {
    return this.inner.getRecord(id);
  }

  flush(id: string): Promise<void> {
    return this.sink.flush(id);
  }
}
