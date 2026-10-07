import path from "node:path";
import { FileStore } from "./file-store";
import { RedisStore } from "./redis-store";
import type { Store } from "./types";

export * from "./types";

const g = globalThis as unknown as { __autotinkerStore?: Store };

/** Redis when Upstash env vars are set, otherwise the file store under web/.data (dev). */
export function getStore(): Store {
  // `instanceof` against the current classes: after a dev hot reload the cached instance belongs to the old module
  // (and would keep parsing events with the old code), so it is replaced.
  const cached = g.__autotinkerStore;
  if (cached && (cached instanceof FileStore || cached instanceof RedisStore)) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  g.__autotinkerStore =
    url && token ? new RedisStore(url, token) : new FileStore(process.env.AUTOTINKER_DATA_DIR ?? path.join(process.cwd(), ".data"));
  return g.__autotinkerStore;
}
