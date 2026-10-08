/**
 * Ownership checks for run APIs and pages.
 *
 * A run that belongs to a session is visible only to that session's owner (other browsers get "not found", so a
 * foreign run id looks like a missing one). Runs that are not in the database (made before Phase 3, or while the
 * database was unreachable) keep the old rule: anyone holding the unguessable run id. Replays are public and never
 * go through here.
 */
import { dbFailed, liveDb } from "./db/client";
import { runOwner } from "./db/repo";
import { currentOwner } from "./identity";

export type RunAccess = { ok: true; owned: boolean; sessionId: string | null; ownerId: string | null } | { ok: false };

export async function runAccess(runId: string): Promise<RunAccess> {
  const ownerId = await currentOwner();
  const db = liveDb();
  if (!db) return { ok: true, owned: false, sessionId: null, ownerId };
  try {
    const row = await runOwner(db, runId);
    if (!row) return { ok: true, owned: false, sessionId: null, ownerId };
    if (ownerId && row.ownerId === ownerId) return { ok: true, owned: true, sessionId: row.sessionId, ownerId };
    return { ok: false };
  } catch (err) {
    dbFailed(err, "ownership check");
    return { ok: true, owned: false, sessionId: null, ownerId };
  }
}
