/**
 * Postgres (Neon) access for durable sessions.
 *
 * Driver: @neondatabase/serverless, HTTP mode (`neon()`), for every app query. Each query is one stateless HTTPS
 * request: nothing to pool or close, so it suits Vercel functions and `next dev` hot reloads (no leaked sockets, no
 * idle connections against Neon's free-tier limits, nothing to wake when Neon scales to zero). The migration script
 * uses the same package's WebSocket Client, because it needs multi-statement transactions.
 *
 * DATABASE_URL_POOLED (or DATABASE_URL) is read server-side only; it is never logged, never sent to a browser and
 * never passed to the engine (see runner/local.ts). When it is missing or Neon is unreachable the app keeps working
 * without durable history: callers use `dbHealthy()` / catch, and the first failure is logged once.
 */
import { neon } from "@neondatabase/serverless";

/** The one method the repo needs; tests pass a fake. */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

const g = globalThis as unknown as { __autotinkerDb?: { url: string; db: Db }; __autotinkerDbDown?: number; __autotinkerDbWarned?: boolean };

export function dbUrl(): string | null {
  return process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL || null;
}

/** The app's DB handle, or null when no database is configured. */
export function getDb(): Db | null {
  const url = dbUrl();
  if (!url) return null;
  if (g.__autotinkerDb?.url !== url) {
    const sql = neon(url);
    g.__autotinkerDb = {
      url,
      db: { query: async <T>(text: string, params: unknown[] = []) => (await sql.query(text, params)) as T[] },
    };
  }
  return g.__autotinkerDb.db;
}

const RETRY_AFTER_MS = 30_000;

/** False for a short while after a connection-level failure, so a down database doesn't slow every request. */
export function dbHealthy(): boolean {
  return !g.__autotinkerDbDown || Date.now() - g.__autotinkerDbDown > RETRY_AFTER_MS;
}

/** Postgres error codes are 5 chars (e.g. 23503); anything else is a network/driver failure. */
export function pgCode(err: unknown): string | null {
  const c = (err as { code?: unknown })?.code;
  return typeof c === "string" && /^[0-9A-Z]{5}$/.test(c) ? c : null;
}

/** Record a failure; logs once per process (never the URL or the query parameters). */
export function dbFailed(err: unknown, where: string): void {
  if (!pgCode(err)) g.__autotinkerDbDown = Date.now();
  if (!g.__autotinkerDbWarned) {
    g.__autotinkerDbWarned = true;
    console.warn(`[db] ${where} failed (${pgCode(err) ?? (err as Error)?.name ?? "error"}); runs keep working, durable history may be incomplete`);
  }
}

export function dbRecovered(): void {
  g.__autotinkerDbDown = 0;
}

/** A usable DB right now, or null (not configured, or recently down). */
export function liveDb(): Db | null {
  const db = getDb();
  return db && dbHealthy() ? db : null;
}
