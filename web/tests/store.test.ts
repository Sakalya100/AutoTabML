import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@/lib/events";
import { FileStore } from "@/lib/store/file-store";
import { RedisStore } from "@/lib/store/redis-store";
import { isValidRunId, type RunMeta } from "@/lib/store/types";

const meta = (id: string): RunMeta => ({
  id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", status: "queued", runner: "local",
  target: "y", description: "", maxExperiments: 5, llm: "heuristic", fileName: "a.csv", fileBytes: 10,
});
const ev = (seq: number): AnyEvent =>
  ({ run_id: "r-abcdef12", seq, ts: "t", type: "decision", exp_id: "e0", decision: "keep", reason: "", best_exp_id: "e0", best_cv_mean: 1 }) as AnyEvent;

describe("FileStore", () => {
  let root: string;
  let store: FileStore;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "atml-"));
    store = new FileStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates, reads and patches meta", async () => {
    await store.createRun(meta("r-abcdef12"));
    expect((await store.getMeta("r-abcdef12"))?.status).toBe("queued");
    const next = await store.updateMeta("r-abcdef12", { status: "running" });
    expect(next?.status).toBe("running");
    expect(next?.updatedAt).not.toBe("2026-01-01T00:00:00Z");
    expect(await store.updateMeta("r-zzzzzz99", { status: "running" })).toBeNull();
  });

  it("appends events in order and drops stale seq, even under concurrent appends", async () => {
    await store.createRun(meta("r-abcdef12"));
    await Promise.all([store.appendEvents("r-abcdef12", [ev(0), ev(1)]), store.appendEvents("r-abcdef12", [ev(1), ev(2)])]);
    expect(await store.appendEvents("r-abcdef12", [ev(2)])).toBe(0);
    expect((await store.readEvents("r-abcdef12")).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect((await store.readEvents("r-abcdef12", 0)).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("recovers lastSeq from disk in a fresh instance", async () => {
    await store.createRun(meta("r-abcdef12"));
    await store.appendEvents("r-abcdef12", [ev(0), ev(1)]);
    const again = new FileStore(root);
    expect(await again.appendEvents("r-abcdef12", [ev(1), ev(5)])).toBe(1);
    expect((await again.readEvents("r-abcdef12")).map((e) => e.seq)).toEqual([0, 1, 5]);
  });

  it("stores records and refuses path-traversal ids", async () => {
    await store.createRun(meta("r-abcdef12"));
    await store.putRecord("r-abcdef12", { run_id: "x" } as never);
    expect((await store.getRecord("r-abcdef12"))?.run_id).toBe("x");
    expect(await store.getMeta("../../etc")).toBeNull();
    expect(await store.readEvents("r-../x")).toEqual([]);
    expect(isValidRunId("r-abc")).toBe(false);
  });
});

describe("RedisStore (protocol shape only — not run against Upstash)", () => {
  it("sends Upstash REST command arrays with the bearer token", async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = new RedisStore("https://example.upstash.io", "tok", fake);
    await s.createRun(meta("r-abcdef12"));
    expect(calls[0].auth).toBe("Bearer tok");
    expect((calls[0].body as string[]).slice(0, 2)).toEqual(["SET", "run:r-abcdef12:meta"]);
    expect(await s.getMeta("r-abcdef12")).toBeNull();
    await expect(s.createRun(meta("bad id"))).rejects.toThrow();
  });
});
