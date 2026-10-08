/**
 * Event-stream helpers. The wire format is JSONL: one event object per line, discriminated by `type`
 * (see src/autotinker/obs/events.py). Types come from the generated src/lib/schema.ts.
 */
import type { RunEvent } from "./schema";

/** The generated types mark `type`/`seq`/`ts` optional (they have Pydantic defaults); on the wire they are always set. */
type Normalize<T> = T extends { type?: infer K } ? Omit<T, "type" | "seq" | "ts"> & { type: NonNullable<K>; seq: number; ts: string } : never;
export type AnyEvent = Normalize<RunEvent>;
export type EventType = AnyEvent["type"];
export type EventOf<K extends EventType> = Extract<AnyEvent, { type: K }>;

/**
 * Event types the engine emits that the generated schema doesn't describe yet. Typed by hand where they are consumed
 * (src/lib/assets.ts); kept separate from EVENT_TYPES so this compiles before and after schema.ts is regenerated.
 */
export const EXTRA_EVENT_TYPES = ["assets_ready"] as const;
export type ExtraEventType = (typeof EXTRA_EVENT_TYPES)[number];

export const EVENT_TYPES: readonly EventType[] = [
  "run_started",
  "experiment_started",
  "llm_call",
  "sandbox_finished",
  "experiment_scored",
  "decision",
  "stopped",
  "run_finished",
  "agent_step_started",
  "agent_reasoning",
  "agent_step_finished",
  "sandbox_log",
  "hpo_trial",
  "report_ready",
  "steer_applied",
] as const;

const REQUIRED: Record<EventType | ExtraEventType, readonly string[]> = {
  run_started: ["task", "profile", "config", "proposer"],
  experiment_started: ["exp_id", "idea"],
  llm_call: ["usage"],
  sandbox_finished: ["exp_id", "attempt", "ok", "duration_s"],
  experiment_scored: ["exp_id", "cv", "select_score"],
  decision: ["exp_id", "decision", "best_exp_id", "best_cv_mean"],
  stopped: ["reason", "report", "summary"],
  run_finished: ["best_exp_id", "dev_cv_mean", "select_score", "test_score", "optimism_gap"],
  // Agentic engine (v3, additive). Older replays simply never contain these.
  agent_step_started: ["step_id", "role"],
  agent_reasoning: ["step_id", "role", "text"],
  agent_step_finished: ["step"],
  sandbox_log: ["exp_id", "lines"],
  hpo_trial: ["exp_id", "trial"],
  report_ready: ["report"],
  steer_applied: ["text"],
  // Charts and downloadable files, after the report. Unknown chart kinds are skipped where it is read.
  assets_ready: ["charts", "files"],
};

export function isEventType(t: unknown): t is EventType | ExtraEventType {
  return typeof t === "string" && ((EVENT_TYPES as readonly string[]).includes(t) || (EXTRA_EVENT_TYPES as readonly string[]).includes(t));
}

/** True for the engine's assets_ready event (compared as a string: the generated schema may not list it yet). */
export function isAssetsReady(ev: { type: string }): boolean {
  return (ev.type as string) === "assets_ready";
}

/**
 * Structural check of one decoded object. Cheaper than full JSON-Schema validation and enough to keep
 * malformed lines out of the store; scripts/validate-replays.mjs does the full schema check for replays.
 */
export function coerceEvent(obj: unknown): AnyEvent | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (!isEventType(o.type) || typeof o.run_id !== "string") return null;
  if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return null;
  for (const k of REQUIRED[o.type]) if (!(k in o)) return null;
  if (o.type === "agent_step_finished") {
    const step = o.step as Record<string, unknown> | null;
    if (!step || typeof step !== "object" || typeof step.role !== "string") return null;
  }
  if (o.type === "sandbox_log" && !Array.isArray(o.lines)) return null;
  if (o.type === "report_ready" && (!o.report || typeof o.report !== "object")) return null;
  if (o.type === "steer_applied" && typeof o.text !== "string") return null;
  if (o.type === "assets_ready" && (!Array.isArray(o.charts) || !Array.isArray(o.files))) return null;
  return { ...o, ts: typeof o.ts === "string" ? o.ts : new Date().toISOString() } as unknown as AnyEvent;
}

/** Parse one JSONL line. Returns null for blank lines, non-JSON lines and non-event objects. */
export function parseEventLine(line: string): AnyEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    return coerceEvent(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Parse a whole JSONL document (e.g. a replay's events.jsonl). Bad lines are skipped. */
export function parseEventsJsonl(text: string): AnyEvent[] {
  const out: AnyEvent[] = [];
  for (const line of text.split("\n")) {
    const ev = parseEventLine(line);
    if (ev) out.push(ev);
  }
  return out;
}

/**
 * Incremental JSONL decoder for a byte/text stream (child-process stdout, sandbox logs).
 * Buffers partial lines across chunks; lines that are not events are reported to `onOther`.
 */
export class JsonlEventDecoder {
  private buf = "";
  private lastSeq = -1;

  constructor(private readonly onOther?: (line: string) => void) {}

  /** Feed a chunk; returns the complete events it finished. Events with non-increasing seq are dropped. */
  push(chunk: string): AnyEvent[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return this.take(parts);
  }

  /** Flush a trailing line without a newline (call when the stream ends). */
  end(): AnyEvent[] {
    const rest = this.buf;
    this.buf = "";
    return rest ? this.take([rest]) : [];
  }

  private take(lines: string[]): AnyEvent[] {
    const out: AnyEvent[] = [];
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (!line.trim()) continue;
      const ev = parseEventLine(line);
      if (!ev) {
        this.onOther?.(line);
        continue;
      }
      if (ev.seq <= this.lastSeq) continue;
      this.lastSeq = ev.seq;
      out.push(ev);
    }
    return out;
  }
}
