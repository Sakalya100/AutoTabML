/** Wire types of the sessions API (shared by route handlers and the workspace UI). */
import type { PublicRunMeta } from "./api";
import type { MessageRow, RunRow } from "./db/repo";
import type { AnyEvent } from "./events";

export type { MessageRow, RunRow, SessionListItem } from "./db/repo";

export interface SessionRunPayload {
  row: RunRow;
  /** Live meta from the run store (null once it has expired there; the row then carries the status). */
  meta: PublicRunMeta | null;
  events: AnyEvent[];
}

export interface SessionPayload {
  session: { id: string; title: string; createdAt: string; updatedAt: string };
  messages: MessageRow[];
  runs: SessionRunPayload[];
}
