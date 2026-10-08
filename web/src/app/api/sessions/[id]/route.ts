import { jsonError, publicMeta } from "@/lib/api";
import { dbFailed, liveDb } from "@/lib/db/client";
import { listMessages, listRuns, ownedSession, readEvents, renameSession } from "@/lib/db/repo";
import { currentOwner } from "@/lib/identity";
import type { SessionPayload, SessionRunPayload } from "@/lib/session-types";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailable = () => jsonError(503, "Saved sessions are unavailable right now. Try again in a minute.");

/** One session: its messages and every run with all of its events (from Postgres), for a full reload/resume. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = liveDb();
  if (!db) return unavailable();
  try {
    const s = await ownedSession(db, id, await currentOwner());
    if (!s) return jsonError(404, "This session doesn't exist in this browser.");
    const [messages, rows] = await Promise.all([listMessages(db, id), listRuns(db, id)]);
    const byRun = await readEvents(
      db,
      rows.map((r) => r.id),
    );
    const store = getStore();
    const runs: SessionRunPayload[] = await Promise.all(
      rows.map(async (row) => {
        const meta = await store.getMeta(row.id).catch(() => null);
        let events = byRun.get(row.id) ?? [];
        // Durable history missed this run (e.g. the database was down): fall back to the live store.
        if (!events.length && meta) events = await store.readEvents(row.id);
        return { row, meta: meta ? publicMeta(meta) : null, events };
      }),
    );
    const body: SessionPayload = {
      session: { id: s.id, title: s.title, createdAt: s.created_at, updatedAt: s.updated_at },
      messages,
      runs,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    dbFailed(err, "loading a session");
    return unavailable();
  }
}

/** Rename: {title}. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owner = await currentOwner();
  const db = liveDb();
  if (!db) return unavailable();
  let title = "";
  try {
    title = String(((await req.json()) as { title?: unknown }).title ?? "");
  } catch {
    return jsonError(400, "Expected JSON: {title}.");
  }
  title = title.replace(/\s+/g, " ").trim();
  if (!title) return jsonError(400, "A session needs a name.", { field: "title" });
  if (title.length > 80) return jsonError(400, "Keep the name under 80 characters.", { field: "title" });
  try {
    if (!owner || !(await renameSession(db, id, owner, title))) return jsonError(404, "This session doesn't exist in this browser.");
    return Response.json({ title });
  } catch (err) {
    dbFailed(err, "renaming a session");
    return unavailable();
  }
}
