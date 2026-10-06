import type { AnyEvent } from "../events";
import type { RunRecord } from "../schema";

export type RunStatus = "queued" | "starting" | "running" | "finished" | "failed" | "cancelled";
export const TERMINAL: readonly RunStatus[] = ["finished", "failed", "cancelled"];
export const isTerminal = (s: RunStatus) => TERMINAL.includes(s);

/**
 * Everything we persist about a run besides its events. Never holds secrets: a BYOK key is passed to the
 * runner for that one run and is not part of this object (see runner/*.ts).
 */
export interface RunMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  runner: "local" | "vercel-sandbox";
  target: string;
  description: string;
  maxExperiments: number;
  llm: "heuristic" | "anthropic";
  fileName: string;
  fileBytes: number;
  /** Short, user-safe failure message. */
  error?: string;
  /** Last lines of the engine's stderr, secrets redacted. */
  errorTail?: string;
  finishedAt?: string;
  /** vercel-sandbox runner: sandbox name + detached command id (for cancel), sha256 of the per-run ingest token. */
  sandboxName?: string;
  commandId?: string;
  ingestTokenSha256?: string;
}

export interface Store {
  readonly kind: "file" | "redis";
  createRun(meta: RunMeta): Promise<void>;
  getMeta(id: string): Promise<RunMeta | null>;
  /** Shallow-merge `patch` into the stored meta; returns the new meta (null if the run does not exist). */
  updateMeta(id: string, patch: Partial<RunMeta>): Promise<RunMeta | null>;
  /** Append events, silently dropping any whose seq is not greater than the last stored seq. Returns #appended. */
  appendEvents(id: string, events: AnyEvent[]): Promise<number>;
  /** Events with seq > afterSeq, in order. */
  readEvents(id: string, afterSeq?: number): Promise<AnyEvent[]>;
  putRecord(id: string, record: RunRecord): Promise<void>;
  getRecord(id: string): Promise<RunRecord | null>;
}

const ID_RE = /^r-[a-z0-9]{6,32}$/;
export const isValidRunId = (id: string) => ID_RE.test(id);
