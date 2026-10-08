import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { ownedSession, runOwner } from "@/lib/db/repo";

// The caller's cookie and the database are faked; runAccess is what every run API and /runs/[id] use.
const state: { owner: string | null; db: Db | null } = { owner: null, db: null };
vi.mock("@/lib/identity", () => ({ currentOwner: async () => state.owner }));
vi.mock("@/lib/db/client", async (orig) => ({ ...(await orig<typeof import("@/lib/db/client")>()), liveDb: () => state.db }));
const { runAccess } = await import("@/lib/access");

const SESSIONS = { "s-aaaaaaaaaa": { owner_id: "o-alice", title: "A" } } as Record<string, { owner_id: string; title: string }>;
const RUNS = { "r-alice00001": "s-aaaaaaaaaa" } as Record<string, string>;
const fakeDb: Db = {
  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    if (text.includes("from sessions where id")) {
      const s = SESSIONS[params[0] as string];
      return (s ? [{ id: params[0], ...s, created_at: new Date(0), updated_at: new Date(0), last_run_id: null }] : []) as T[];
    }
    if (text.includes("from runs r join sessions")) {
      const sid = RUNS[params[0] as string];
      return (sid ? [{ session_id: sid, owner_id: SESSIONS[sid].owner_id }] : []) as T[];
    }
    return [];
  },
};

describe("ownership", () => {
  beforeEach(() => {
    state.owner = null;
    state.db = fakeDb;
  });

  it("only the owner sees a session", async () => {
    expect(await ownedSession(fakeDb, "s-aaaaaaaaaa", "o-alice")).not.toBeNull();
    expect(await ownedSession(fakeDb, "s-aaaaaaaaaa", "o-mallory")).toBeNull();
    expect(await ownedSession(fakeDb, "s-aaaaaaaaaa", null)).toBeNull();
    expect(await ownedSession(fakeDb, "../etc", "o-alice")).toBeNull(); // malformed ids never reach SQL
    expect(await runOwner(fakeDb, "r-alice00001")).toEqual({ sessionId: "s-aaaaaaaaaa", ownerId: "o-alice" });
  });

  it("run APIs: owner yes, others not found, no cookie not found", async () => {
    state.owner = "o-alice";
    expect(await runAccess("r-alice00001")).toEqual({ ok: true, owned: true, sessionId: "s-aaaaaaaaaa", ownerId: "o-alice" });
    state.owner = "o-mallory";
    expect(await runAccess("r-alice00001")).toEqual({ ok: false });
    state.owner = null;
    expect(await runAccess("r-alice00001")).toEqual({ ok: false });
  });

  it("runs without a session (pre-sessions, or DB down) keep the unguessable-id rule", async () => {
    state.owner = "o-mallory";
    expect(await runAccess("r-legacy0001")).toMatchObject({ ok: true, owned: false, sessionId: null });
    state.db = null;
    expect(await runAccess("r-alice00001")).toMatchObject({ ok: true, owned: false });
  });
});
