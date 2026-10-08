import path from "node:path";
import { getDb } from "../db/client";
import { EventSink } from "../db/persist";
import { FileStore } from "./file-store";
import { PersistingStore } from "./persisting-store";
import { RedisStore } from "./redis-store";
import type { Store } from "./types";

export * from "./types";

const g = globalThis as unknown as { __autotinkerStore?: Store };

/**
 * Redis when Upstash env vars are set, otherwise the file store under web/.data (dev). When a database is configured
 * the store is wrapped so every event and status change is also persisted to Postgres (durable sessions).
 */
export function getStore(): Store {
  // `instanceof` against the current classes: after a dev hot reload the cached instance belongs to the old module
  // (and would keep parsing events with the old code), so it is replaced.
  const cached = g.__autotinkerStore;
  const fresh = (s: Store | undefined) => s instanceof FileStore || s instanceof RedisStore;
  if (cached && (cached instanceof PersistingStore ? fresh(cached.inner) : fresh(cached))) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const base: Store =
    url && token ? new RedisStore(url, token) : new FileStore(process.env.AUTOTINKER_DATA_DIR ?? path.join(process.cwd(), ".data"));
  g.__autotinkerStore = getDb() ? new PersistingStore(base, new EventSink(getDb)) : base;
  return g.__autotinkerStore;
}
