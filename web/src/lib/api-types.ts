/**
 * Wire types of the backend API (backend/, FastAPI). The browser only ever sees these JSON shapes; the server code
 * that produces them lives in backend/autotinker_api (repo.py: public_meta, public_run_row, list_sessions).
 */
import type { ColumnStats, Delimiter } from "./ingest/csv";

export type RunStatus = "queued" | "starting" | "running" | "finished" | "failed" | "cancelled" | "timed_out";
/** `timed_out`: the watchdog stopped a run that went quiet or hit its time limit (experiments so far are kept). */
export const TERMINAL: readonly RunStatus[] = ["finished", "failed", "cancelled", "timed_out"];
export const isTerminal = (s: string | null | undefined): boolean => !!s && (TERMINAL as readonly string[]).includes(s);

/** What the browser may see about a run. */
export interface PublicRunMeta {
  id: string;
  /** The session the run belongs to (every run has one). */
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  runner: "local" | "sandbox";
  target: string;
  /** The user's sentence ("predict churn"); passed to the engine as --goal. */
  description: string;
  maxExperiments: number;
  metric?: string;
  source?: "url" | "file";
  sourceUrl?: string;
  engine?: "agentic";
  /** Legacy (pre-agentic) runs only. */
  llm?: "heuristic" | "anthropic";
  fileName: string;
  fileBytes: number;
  /** Short, user-safe failure message. */
  error?: string;
  /** Last lines of the engine's stderr, secrets redacted. */
  errorTail?: string;
  finishedAt?: string;
}

export type MessageRole = "user" | "system";
export type MessageKind = "chat" | "steer" | "control";

/** A session in the sidebar, with its latest run's status and best score. */
export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  runId: string | null;
  status: RunStatus | null;
  best: number | null;
  metric: string | null;
  fileName: string | null;
}

export interface RunRow {
  id: string;
  session_id: string;
  status: RunStatus;
  source_url: string | null;
  file_name: string | null;
  target: string;
  metric: string | null;
  goal: string;
  max_experiments: number;
  created_at: string;
  finished_at: string | null;
  best: number | null;
  summary: Record<string, unknown>;
}

export interface MessageRow {
  id: string;
  session_id: string;
  run_id: string | null;
  role: MessageRole;
  text: string;
  kind: MessageKind;
  created_at: string;
}

/** POST /api/preview → preview. */
export interface Preview {
  /** The link as pasted, and the direct link the engine will download. */
  url: string;
  resolvedUrl: string;
  finalUrl: string;
  rewritten: boolean;
  delimiter: Delimiter;
  columns: string[];
  stats: ColumnStats[];
  /** Up to 50 rows, for display in the browser only. */
  sample: string[][];
  /** Exact if the whole file was read, else an estimate from the content length (null if unknown). */
  rows: number | null;
  rowsExact: boolean;
  sizeBytes: number | null;
}
