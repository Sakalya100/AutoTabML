import { jsonError } from "@/lib/api";
import { classifyMessage, MAX_MESSAGE_CHARS } from "@/lib/chat-input";
import { dbFailed, liveDb } from "@/lib/db/client";
import { insertMessage, ownedSession, type MessageRow } from "@/lib/db/repo";
import { currentOwner } from "@/lib/identity";
import { getRunner } from "@/lib/runner";
import { getStore, isTerminal } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STOP_ACK = "Stopping after the current experiment. Then the best model is scored once on the locked test and the report is written.";

/**
 * A message typed into a session. Body: {text} or {kind: "stop"} (the Stop button).
 * The server classifies it again (lib/chat-input.ts): during a run "stop" is a graceful stop, anything else steers the
 * Planner; without a run it's plain chat. Steers are acknowledged by the engine's `steer_applied` event, not here.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = liveDb();
  if (!db) return jsonError(503, "Saved sessions are unavailable right now, so messages can't be sent.");
  let body: { text?: unknown; kind?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'Expected JSON: {text} or {kind: "stop"}.');
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (body.kind !== "stop" && !text) return jsonError(400, "Type a message first.", { field: "text" });
  if (text.length > MAX_MESSAGE_CHARS) return jsonError(400, `Keep messages under ${MAX_MESSAGE_CHARS} characters.`, { field: "text" });

  try {
    const session = await ownedSession(db, id, await currentOwner());
    if (!session) return jsonError(404, "This session doesn't exist in this browser.");
    const store = getStore();
    const meta = session.last_run_id ? await store.getMeta(session.last_run_id) : null;
    const active = !!meta && !isTerminal(meta.status);
    const intent = body.kind === "stop" ? ({ kind: "control", command: "stop" } as const) : classifyMessage(text, { runActive: active });
    if (intent.kind === "control" && !active) return jsonError(409, "Nothing is running in this session.");
    // Once the engine has decided to stop, it is scoring the locked test / writing the report: a stop (or a steer) would
    // only risk cancelling a run that is about to finish on its own.
    if (intent.kind !== "chat" && meta && (await store.readEvents(meta.id)).some((e) => e.type === "stopped"))
      return jsonError(409, "The run has already stopped: it's scoring the locked test and writing the report.");

    const out: MessageRow[] = [];
    const runId = active && meta ? meta.id : null;
    out.push(
      await insertMessage(db, {
        sessionId: id,
        runId,
        role: "user",
        text: intent.kind === "control" ? text || "Stop" : intent.text,
        kind: intent.kind,
      }),
    );
    let delivered = false;
    if (intent.kind === "control" && meta) {
      const runner = getRunner(meta.runner);
      delivered = await runner.control(meta, { type: "stop" }).catch(() => false);
      if (delivered) out.push(await insertMessage(db, { sessionId: id, runId, role: "system", text: STOP_ACK, kind: "control" }));
      else {
        // No control channel (dev-server restart, sandbox runner): stop it the hard way.
        await runner.cancel(meta).catch(() => false);
        await store.updateMeta(meta.id, { status: "cancelled", error: "Cancelled by user.", finishedAt: new Date().toISOString() });
        out.push(
          await insertMessage(db, {
            sessionId: id,
            runId,
            role: "system",
            text: "The engine couldn't take a graceful stop, so the run was cancelled. Everything up to now is kept; there is no locked-test score.",
            kind: "control",
          }),
        );
      }
    } else if (intent.kind === "steer" && meta) {
      delivered = await getRunner(meta.runner)
        .control(meta, { type: "steer", text: intent.text })
        .catch(() => false);
      if (!delivered)
        out.push(
          await insertMessage(db, {
            sessionId: id,
            runId,
            role: "system",
            text: "The engine couldn't be reached, so this wasn't passed on to the agents.",
            kind: "steer",
          }),
        );
    } else if (intent.kind === "chat") {
      out.push(
        await insertMessage(db, {
          sessionId: id,
          runId: null,
          role: "system",
          text: "Nothing is running here right now. Paste a link to a CSV to start another run in this session.",
          kind: "chat",
        }),
      );
    }
    return Response.json({ messages: out, intent: intent.kind, delivered }, { status: 201 });
  } catch (err) {
    dbFailed(err, "sending a message");
    return jsonError(503, "Saved sessions are unavailable right now, so messages can't be sent.");
  }
}
