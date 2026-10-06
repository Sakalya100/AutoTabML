import { createHash } from "node:crypto";
import type { RunMeta } from "./store/types";

/** The subset of RunMeta that is safe to send to browsers. */
export type PublicRunMeta = Omit<RunMeta, "ingestTokenSha256" | "commandId" | "sandboxName">;

export function publicMeta(m: RunMeta): PublicRunMeta {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ingestTokenSha256, commandId, sandboxName, ...rest } = m;
  return rest;
}

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}, headers?: HeadersInit) {
  return Response.json({ error, ...extra }, { status, headers });
}

export function newRunId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return "r-" + Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
