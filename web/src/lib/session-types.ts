/** Wire types of the sessions API (the backend's GET /api/sessions/{id}). */
import type { MessageRow, PublicRunMeta, RunRow } from "./api-types";
import type { AnyEvent } from "./events";

export type { MessageRow, RunRow, SessionListItem } from "./api-types";

export interface SessionRunPayload {
  row: RunRow;
  meta: PublicRunMeta | null;
  events: AnyEvent[];
}

export interface SessionPayload {
  session: { id: string; title: string; createdAt: string; updatedAt: string };
  messages: MessageRow[];
  runs: SessionRunPayload[];
}
