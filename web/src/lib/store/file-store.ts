/**
 * Dev store: <root>/runs/<id>/{meta.json,events.jsonl,run.json}. Single-process only — writes to one run are
 * serialised through an in-memory promise chain, which is fine for `next dev` / a single `next start`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AnyEvent } from "../events";
import { parseEventsJsonl } from "../events";
import type { RunRecord } from "../schema";
import { isValidRunId, type RunMeta, type Store } from "./types";

export class FileStore implements Store {
  readonly kind = "file" as const;
  private locks = new Map<string, Promise<unknown>>();
  private lastSeq = new Map<string, number>();

  constructor(private readonly root: string) {}

  runDir(id: string): string {
    if (!isValidRunId(id)) throw new Error(`invalid run id`);
    return path.join(this.root, "runs", id);
  }

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(id, next.catch(() => undefined));
    return next;
  }

  async createRun(meta: RunMeta): Promise<void> {
    const dir = this.runDir(meta.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    await fs.writeFile(path.join(dir, "events.jsonl"), "", { flag: "a" });
    this.lastSeq.set(meta.id, -1);
  }

  async getMeta(id: string): Promise<RunMeta | null> {
    if (!isValidRunId(id)) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.runDir(id), "meta.json"), "utf8")) as RunMeta;
    } catch {
      return null;
    }
  }

  updateMeta(id: string, patch: Partial<RunMeta>): Promise<RunMeta | null> {
    return this.serial(id, async () => {
      const cur = await this.getMeta(id);
      if (!cur) return null;
      const next: RunMeta = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
      const file = path.join(this.runDir(id), "meta.json");
      await fs.writeFile(file + ".tmp", JSON.stringify(next, null, 2));
      await fs.rename(file + ".tmp", file);
      return next;
    });
  }

  appendEvents(id: string, events: AnyEvent[]): Promise<number> {
    return this.serial(id, async () => {
      if (!events.length) return 0;
      let last = this.lastSeq.get(id);
      if (last === undefined) {
        const existing = await this.readEvents(id);
        last = existing.length ? existing[existing.length - 1].seq : -1;
      }
      const fresh: AnyEvent[] = [];
      for (const e of events) {
        if (e.seq > last) {
          fresh.push(e);
          last = e.seq;
        }
      }
      if (fresh.length) {
        await fs.appendFile(path.join(this.runDir(id), "events.jsonl"), fresh.map((e) => JSON.stringify(e) + "\n").join(""));
      }
      this.lastSeq.set(id, last);
      return fresh.length;
    });
  }

  async readEvents(id: string, afterSeq = -1): Promise<AnyEvent[]> {
    if (!isValidRunId(id)) return [];
    let text: string;
    try {
      text = await fs.readFile(path.join(this.runDir(id), "events.jsonl"), "utf8");
    } catch {
      return [];
    }
    return parseEventsJsonl(text).filter((e) => e.seq > afterSeq);
  }

  async putRecord(id: string, record: RunRecord): Promise<void> {
    await fs.writeFile(path.join(this.runDir(id), "run.json"), JSON.stringify(record));
  }

  async getRecord(id: string): Promise<RunRecord | null> {
    if (!isValidRunId(id)) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.runDir(id), "run.json"), "utf8")) as RunRecord;
    } catch {
      return null;
    }
  }
}
