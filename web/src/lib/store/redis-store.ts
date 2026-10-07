/**
 * Production store on Upstash Redis via its REST API (env UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
 *
 * UNTESTED: no Upstash credentials were available when this was written. It follows the documented REST
 * protocol (POST a JSON command array to the base URL, or an array of arrays to /pipeline) but has not been
 * run against a real instance. Keys expire after RUN_TTL_S (24h — uploads/runs are not kept longer).
 *
 * Keys: run:<id>:meta (JSON string) · run:<id>:events (list of JSON lines) · run:<id>:lastseq · run:<id>:record
 * Seq de-duplication uses a small Lua script so concurrent appenders (ingest retries) cannot reorder events.
 */
import type { AnyEvent } from "../events";
import { coerceEvent } from "../events";
import type { RunRecord } from "../schema";
import { isValidRunId, type RunMeta, type Store } from "./types";

const RUN_TTL_S = 60 * 60 * 24;

// KEYS[1]=events KEYS[2]=lastseq ARGV[1]=ttl ARGV[2..]=pairs of (seq, json). Returns #appended.
const APPEND_LUA = `
local last = tonumber(redis.call('GET', KEYS[2]) or '-1')
local n = 0
for i = 2, #ARGV, 2 do
  local s = tonumber(ARGV[i])
  if s > last then
    redis.call('RPUSH', KEYS[1], ARGV[i + 1])
    last = s
    n = n + 1
  end
end
redis.call('SET', KEYS[2], tostring(last), 'EX', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return n`;

type Cmd = (string | number)[];

export class RedisStore implements Store {
  readonly kind = "redis" as const;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T = unknown>(cmd: Cmd): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd.map(String)),
      cache: "no-store",
    });
    const body = (await res.json()) as { result?: T; error?: string };
    if (!res.ok || body.error) throw new Error(`upstash ${cmd[0]} failed: ${body.error ?? res.status}`);
    return body.result as T;
  }

  private key(id: string, part: string) {
    if (!isValidRunId(id)) throw new Error("invalid run id");
    return `run:${id}:${part}`;
  }

  async createRun(meta: RunMeta): Promise<void> {
    await this.call(["SET", this.key(meta.id, "meta"), JSON.stringify(meta), "EX", RUN_TTL_S]);
  }

  async getMeta(id: string): Promise<RunMeta | null> {
    if (!isValidRunId(id)) return null;
    const raw = await this.call<string | null>(["GET", this.key(id, "meta")]);
    return raw ? (JSON.parse(raw) as RunMeta) : null;
  }

  async updateMeta(id: string, patch: Partial<RunMeta>): Promise<RunMeta | null> {
    // Read-modify-write; meta is only written by one runner per run, so last-writer-wins is acceptable here.
    const cur = await this.getMeta(id);
    if (!cur) return null;
    const next: RunMeta = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    await this.call(["SET", this.key(id, "meta"), JSON.stringify(next), "EX", RUN_TTL_S]);
    return next;
  }

  async appendEvents(id: string, events: AnyEvent[]): Promise<number> {
    if (!events.length) return 0;
    const args: Cmd = [RUN_TTL_S];
    for (const e of events) args.push(e.seq, JSON.stringify(e));
    return Number(await this.call(["EVAL", APPEND_LUA, 2, this.key(id, "events"), this.key(id, "lastseq"), ...args]));
  }

  async readEvents(id: string, afterSeq = -1): Promise<AnyEvent[]> {
    if (!isValidRunId(id)) return [];
    // Events are stored in seq order without gaps in the list index, so a client that has seen N events
    // could LRANGE from N; we filter by seq instead to stay correct if the engine ever skips seq numbers.
    const rows = await this.call<string[]>(["LRANGE", this.key(id, "events"), 0, -1]);
    const out: AnyEvent[] = [];
    for (const r of rows ?? []) {
      const e = coerceEvent(JSON.parse(r));
      if (e && e.seq > afterSeq) out.push(e);
    }
    return out;
  }

  async putRecord(id: string, record: RunRecord): Promise<void> {
    await this.call(["SET", this.key(id, "record"), JSON.stringify(record), "EX", RUN_TTL_S]);
  }

  async getRecord(id: string): Promise<RunRecord | null> {
    if (!isValidRunId(id)) return null;
    const raw = await this.call<string | null>(["GET", this.key(id, "record")]);
    return raw ? (JSON.parse(raw) as RunRecord) : null;
  }
}
