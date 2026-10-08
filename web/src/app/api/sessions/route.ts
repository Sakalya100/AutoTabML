import { jsonError } from "@/lib/api";
import { dbFailed, liveDb } from "@/lib/db/client";
import { listSessions } from "@/lib/db/repo";
import { currentOwner } from "@/lib/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's sessions, newest first, each with its latest run's status and best score. */
export async function GET() {
  const owner = await currentOwner();
  if (!owner) return Response.json({ sessions: [] }, { headers: { "Cache-Control": "no-store" } });
  const db = liveDb();
  if (!db) return jsonError(503, "Saved sessions are unavailable right now. Runs still work.", { sessions: [] });
  try {
    return Response.json({ sessions: await listSessions(db, owner) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    dbFailed(err, "listing sessions");
    return jsonError(503, "Saved sessions are unavailable right now. Runs still work.", { sessions: [] });
  }
}
