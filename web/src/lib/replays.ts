import { promises as fs } from "node:fs";
import path from "node:path";
import { parseEventsJsonl, type AnyEvent } from "./events";
import type { RunRecord } from "./schema";

export interface ReplayInfo {
  name: string;
  title: string;
  dataset: string;
  metric: string;
  proposer: string;
  n_experiments: number;
  stop_reason: string;
  fixture?: boolean;
  blurb?: string;
}

const dir = () => path.join(process.cwd(), "public", "replays");
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export async function listReplays(): Promise<ReplayInfo[]> {
  try {
    const idx = JSON.parse(await fs.readFile(path.join(dir(), "index.json"), "utf8")) as { replays: ReplayInfo[] };
    return idx.replays ?? [];
  } catch {
    return [];
  }
}

export async function loadReplay(name: string): Promise<{ info: ReplayInfo; record: RunRecord; events: AnyEvent[] } | null> {
  if (!NAME_RE.test(name)) return null;
  const info = (await listReplays()).find((r) => r.name === name);
  if (!info) return null;
  try {
    const [rec, ev] = await Promise.all([
      fs.readFile(path.join(dir(), name, "run.json"), "utf8"),
      fs.readFile(path.join(dir(), name, "events.jsonl"), "utf8"),
    ]);
    return { info, record: JSON.parse(rec) as RunRecord, events: parseEventsJsonl(ev) };
  } catch {
    return null;
  }
}
