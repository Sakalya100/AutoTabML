import path from "node:path";
import { FileStore } from "./file-store";
import { RedisStore } from "./redis-store";
import type { Store } from "./types";

export * from "./types";

const g = globalThis as unknown as { __autotabmlStore?: Store };

/** Redis when Upstash env vars are set, otherwise the file store under web/.data (dev). */
export function getStore(): Store {
  if (g.__autotabmlStore) return g.__autotabmlStore;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  g.__autotabmlStore =
    url && token ? new RedisStore(url, token) : new FileStore(process.env.AUTOTABML_DATA_DIR ?? path.join(process.cwd(), ".data"));
  return g.__autotabmlStore;
}
