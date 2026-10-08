/**
 * Optional integration test against a real Postgres (Neon): the migration, idempotent event inserts and the
 * ownership queries, inside a throwaway schema that is dropped afterwards.
 *   AUTOTINKER_DB_IT=1 npx vitest run tests/sessions-db.test.ts   (with DATABASE_URL in the environment)
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { EventSink } from "@/lib/db/persist";
import { createSession, insertEvents, insertMessage, insertRun, listMessages, listSessions, ownedSession, readEvents, runOwner } from "@/lib/db/repo";
import type { AnyEvent } from "@/lib/events";

const url = process.env.DATABASE_URL;
const enabled = process.env.AUTOTINKER_DB_IT === "1" && !!url;
const schema = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(!enabled)("sessions on a real Postgres", () => {
  let client: Client;
  let db: Db;
  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}`);
    const dir = path.join(__dirname, "..", "db", "migrations");
    for (const f of readdirSync(dir).sort()) await client.query(readFileSync(path.join(dir, f), "utf8"));
    db = { query: async <T,>(text: string, params: unknown[] = []) => (await client.query(text, params)).rows as T[] };
  }, 30_000);
  afterAll(async () => {
    if (!client) return;
    await client.query(`drop schema if exists ${schema} cascade`);
    await client.end();
  });

  it("migrates, persists events idempotently and enforces ownership", async () => {
    await createSession(db, { id: "s-itsession1", ownerId: "o-itowner-aaaaaaaaaaaa", title: "Predicting y" });
    await insertRun(db, { id: "r-itrun0001", sessionId: "s-itsession1", status: "running", target: "y", goal: "", maxExperiments: 3 });
    const evs = [1, 2, 3].map((seq) => ({ run_id: "x", seq, ts: new Date().toISOString(), type: "sandbox_log", exp_id: "e000", lines: [] }) as unknown as AnyEvent);
    await insertEvents(db, "r-itrun0001", evs);
    await insertEvents(db, "r-itrun0001", evs); // duplicate delivery
    const sink = new EventSink(() => db, { flushMs: 1 });
    sink.enqueue("r-itrun0001", [evs[2], { ...evs[0], seq: 4 } as AnyEvent]);
    await sink.flush("r-itrun0001");
    sink.enqueue("r-unknown01", evs); // not in runs: FK violation, skipped quietly
    await sink.flush("r-unknown01");
    const got = (await readEvents(db, ["r-itrun0001"])).get("r-itrun0001")!;
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(await runOwner(db, "r-itrun0001")).toEqual({ sessionId: "s-itsession1", ownerId: "o-itowner-aaaaaaaaaaaa" });
    expect(await ownedSession(db, "s-itsession1", "o-someone-else-aaaaaaa")).toBeNull();
    await insertMessage(db, { sessionId: "s-itsession1", runId: "r-itrun0001", role: "user", text: "prefer linear", kind: "steer" });
    expect((await listMessages(db, "s-itsession1")).map((m) => m.kind)).toEqual(["steer"]);
    const [s] = await listSessions(db, "o-itowner-aaaaaaaaaaaa");
    expect(s).toMatchObject({ id: "s-itsession1", runId: "r-itrun0001", status: "running" });
  }, 30_000);
});
