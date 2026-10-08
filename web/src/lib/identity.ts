/**
 * Anonymous identity: one signed, httpOnly cookie per browser holds an owner id. Sessions, runs and messages belong
 * to that owner; replays stay public. Real auth (GitHub/Google) comes later (docs/AGENTIC_PLAN.md §6).
 *
 *   cookie  at_owner = <ownerId>.<base64url HMAC-SHA256(secret, "owner:" + ownerId)>
 *
 * The secret is AUTOTINKER_SESSION_SECRET (32 random bytes, base64; web/.env.local or the deployment's env). It is
 * server-only: never logged, never sent to the browser, never passed to the engine (server-env.ts filters *SECRET*).
 * The proxy (src/proxy.ts) mints the cookie on the first page or API request, so route handlers can just read it.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OWNER_COOKIE = "at_owner";
const ONE_YEAR_S = 60 * 60 * 24 * 365;
const OWNER_RE = /^o-[A-Za-z0-9_-]{16,64}$/;

const g = globalThis as unknown as { __autotinkerEphemeralSecret?: string; __autotinkerSecretWarned?: boolean };

/** The signing secret. Without one (misconfigured dev), a per-process random secret: identities reset on restart. */
export function sessionSecret(): string {
  const s = process.env.AUTOTINKER_SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production" && process.env.VERCEL) throw new Error("AUTOTINKER_SESSION_SECRET is not set");
  if (!g.__autotinkerSecretWarned) {
    g.__autotinkerSecretWarned = true;
    console.warn("[identity] AUTOTINKER_SESSION_SECRET is not set; using a temporary secret (sessions reset on restart)");
  }
  return (g.__autotinkerEphemeralSecret ??= randomBytes(32).toString("base64"));
}

const mac = (id: string, secret: string) => createHmac("sha256", secret).update(`owner:${id}`).digest("base64url");

export function newOwnerId(): string {
  return "o-" + randomBytes(18).toString("base64url");
}

export function signOwner(id: string, secret = sessionSecret()): string {
  return `${id}.${mac(id, secret)}`;
}

/** The owner id in a cookie value, or null if it is malformed or the signature doesn't match. */
export function verifyOwner(value: string | null | undefined, secret = sessionSecret()): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  if (!OWNER_RE.test(id)) return null;
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(mac(id, secret));
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
}

export function ownerCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_S,
  };
}

/** Read the caller's owner id in a route handler / server component (null when there is no valid cookie). */
export async function currentOwner(): Promise<string | null> {
  const { cookies } = await import("next/headers");
  return verifyOwner((await cookies()).get(OWNER_COOKIE)?.value);
}

/** Route handlers that create things: the caller's owner id, minting (and setting) a cookie if there is none. */
export async function requireOwner(): Promise<string> {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  const existing = verifyOwner(jar.get(OWNER_COOKIE)?.value);
  if (existing) return existing;
  const id = newOwnerId();
  jar.set(OWNER_COOKIE, signOwner(id), ownerCookieOptions());
  return id;
}
