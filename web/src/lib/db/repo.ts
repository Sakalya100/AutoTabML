/**
 * Queries over the Phase-3 schema (db/migrations/001_sessions.sql). Every function takes the Db explicitly so tests
 * can pass a fake. Ownership is enforced by the callers through `sessionOwner` / `runOwner`.
 */
import type { AnyEvent } from "../events";
import type { RunStatus } from "../store/types";
import type { Db } from "./client";

export type MessageRole = "user" | "system";
export type MessageKind = "chat" | "steer" | "control";

export interface SessionRow {
  id: string;
  owner_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_run_id: string | null;
}

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

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

function randomId(prefix: string, n = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return prefix + Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}
export const newSessionId = () => randomId("s-");
export const newMessageId = () => randomId("m-", 14);

const SESSION_ID_RE = /^s-[a-z0-9]{6,32}$/;
export const isValidSessionId = (id: string) => SESSION_ID_RE.test(id);

/* ---- owners & sessions ------------------------------------------------------------------------------- */

export async function ensureOwner(db: Db, ownerId: string): Promise<void> {
  await db.query("insert into owners (id) values ($1) on conflict (id) do nothing", [ownerId]);
}

export async function createSession(db: Db, s: { id: string; ownerId: string; title: string }): Promise<void> {
  await ensureOwner(db, s.ownerId);
  await db.query("insert into sessions (id, owner_id, title) values ($1, $2, $3)", [s.id, s.ownerId, s.title.slice(0, 120)]);
}

export async function getSession(db: Db, id: string): Promise<SessionRow | null> {
  if (!isValidSessionId(id)) return null;
  const rows = await db.query<SessionRow>("select id, owner_id, title, created_at, updated_at, last_run_id from sessions where id = $1", [id]);
  const r = rows[0];
  return r ? { ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) } : null;
}

/** The session if `ownerId` owns it, else null (missing and foreign look the same to the caller). */
export async function ownedSession(db: Db, id: string, ownerId: string | null): Promise<SessionRow | null> {
  if (!ownerId) return null;
  const s = await getSession(db, id);
  return s && s.owner_id === ownerId ? s : null;
}

export async function listSessions(db: Db, ownerId: string, limit = 100): Promise<SessionListItem[]> {
  const rows = await db.query<Record<string, unknown>>(
    `select s.id, s.title, s.created_at, s.updated_at, s.last_run_id,
            r.status, r.best, r.metric, r.file_name
       from sessions s left join runs r on r.id = s.last_run_id
      where s.owner_id = $1
      order by s.updated_at desc
      limit $2`,
    [ownerId, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    runId: (r.last_run_id as string | null) ?? null,
    status: (r.status as RunStatus | null) ?? null,
    best: r.best == null ? null : Number(r.best),
    metric: (r.metric as string | null) ?? null,
    fileName: (r.file_name as string | null) ?? null,
  }));
}

export async function renameSession(db: Db, id: string, ownerId: string, title: string): Promise<boolean> {
  const rows = await db.query("update sessions set title = $3, updated_at = now() where id = $1 and owner_id = $2 returning id", [id, ownerId, title]);
  return rows.length > 0;
}

/* ---- runs ------------------------------------------------------------------------------------------- */

export interface NewRun {
  id: string;
  sessionId: string;
  status: RunStatus;
  sourceUrl?: string | null;
  fileName?: string | null;
  target: string;
  metric?: string | null;
  goal: string;
  maxExperiments: number;
}

export async function insertRun(db: Db, r: NewRun): Promise<void> {
  await db.query(
    `insert into runs (id, session_id, status, source_url, file_name, target, metric, goal, max_experiments)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (id) do nothing`,
    [r.id, r.sessionId, r.status, r.sourceUrl ?? null, r.fileName ?? null, r.target, r.metric ?? null, r.goal, r.maxExperiments],
  );
  await db.query("update sessions set last_run_id = $2, updated_at = now() where id = $1", [r.sessionId, r.id]);
}

/** Who owns a run: null when the run is not in the database (legacy runs, or created while the DB was down). */
export async function runOwner(db: Db, runId: string): Promise<{ sessionId: string; ownerId: string } | null> {
  const rows = await db.query<{ session_id: string; owner_id: string }>(
    "select r.session_id, s.owner_id from runs r join sessions s on s.id = r.session_id where r.id = $1",
    [runId],
  );
  return rows[0] ? { sessionId: rows[0].session_id, ownerId: rows[0].owner_id } : null;
}

export async function listRuns(db: Db, sessionId: string): Promise<RunRow[]> {
  const rows = await db.query<RunRow>("select * from runs where session_id = $1 order by created_at", [sessionId]);
  return rows.map((r) => ({
    ...r,
    created_at: iso(r.created_at),
    finished_at: isoOrNull(r.finished_at),
    best: r.best == null ? null : Number(r.best),
    summary: (r.summary ?? {}) as Record<string, unknown>,
  }));
}

export interface RunPatch {
  status?: RunStatus;
  finishedAt?: string | null;
  best?: number | null;
  /** Shallow-merged into summary jsonb. */
  summary?: Record<string, unknown>;
}

export async function updateRun(db: Db, runId: string, p: RunPatch): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [runId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    sets.push(sql.replace("?", `$${params.length}`));
  };
  if (p.status) add("status = ?", p.status);
  if (p.finishedAt !== undefined) add("finished_at = ?::timestamptz", p.finishedAt);
  if (p.best !== undefined) add("best = ?", p.best);
  if (p.summary && Object.keys(p.summary).length) add("summary = summary || ?::jsonb", JSON.stringify(p.summary));
  if (!sets.length) return;
  await db.query(`update runs set ${sets.join(", ")} where id = $1`, params);
  if (p.status) await db.query("update sessions set updated_at = now() where last_run_id = $1", [runId]);
}

/* ---- events ----------------------------------------------------------------------------------------- */

/** The SQL used to persist events: one round trip per batch, idempotent on (run_id, seq). */
export const INSERT_EVENTS_SQL = `insert into run_events (run_id, seq, type, payload, ts)
  select u.run_id, u.seq, u.type, u.payload::jsonb, u.ts::timestamptz
    from unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[]) as u(run_id, seq, type, payload, ts)
  on conflict (run_id, seq) do nothing`;

export async function insertEvents(db: Db, runId: string, events: readonly AnyEvent[]): Promise<void> {
  if (!events.length) return;
  const ts = (t: string) => (Number.isFinite(Date.parse(t)) ? t : new Date().toISOString());
  await db.query(INSERT_EVENTS_SQL, [
    events.map(() => runId),
    events.map((e) => e.seq),
    events.map((e) => e.type),
    events.map((e) => JSON.stringify(e)),
    events.map((e) => ts(e.ts)),
  ]);
}

/** All events of the given runs, by run, in seq order. */
export async function readEvents(db: Db, runIds: readonly string[]): Promise<Map<string, AnyEvent[]>> {
  const out = new Map<string, AnyEvent[]>(runIds.map((id) => [id, []]));
  if (!runIds.length) return out;
  const rows = await db.query<{ run_id: string; payload: unknown }>(
    "select run_id, payload from run_events where run_id = any($1::text[]) order by run_id, seq",
    [runIds],
  );
  for (const r of rows) {
    const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
    out.get(r.run_id)?.push(p as AnyEvent);
  }
  return out;
}

/* ---- messages --------------------------------------------------------------------------------------- */

export async function insertMessage(
  db: Db,
  m: { sessionId: string; runId?: string | null; role: MessageRole; text: string; kind: MessageKind },
): Promise<MessageRow> {
  const rows = await db.query<MessageRow>(
    `insert into messages (id, session_id, run_id, role, text, kind) values ($1, $2, $3, $4, $5, $6)
     returning id, session_id, run_id, role, text, kind, created_at`,
    [newMessageId(), m.sessionId, m.runId ?? null, m.role, m.text.slice(0, 4000), m.kind],
  );
  await db.query("update sessions set updated_at = now() where id = $1", [m.sessionId]);
  return { ...rows[0], created_at: iso(rows[0].created_at) };
}

export async function listMessages(db: Db, sessionId: string): Promise<MessageRow[]> {
  const rows = await db.query<MessageRow>(
    "select id, session_id, run_id, role, text, kind, created_at from messages where session_id = $1 order by created_at, id",
    [sessionId],
  );
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }));
}
