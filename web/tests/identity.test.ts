import { afterEach, describe, expect, it, vi } from "vitest";
import { newOwnerId, ownerCookieOptions, signOwner, verifyOwner } from "@/lib/identity";
import { engineEnv, knownSecrets } from "@/lib/server-env";

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";

describe("owner cookie", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips a fresh owner id", () => {
    const id = newOwnerId();
    expect(id).toMatch(/^o-[A-Za-z0-9_-]{24}$/);
    expect(verifyOwner(signOwner(id, SECRET), SECRET)).toBe(id);
  });

  it("rejects tampering, another secret, and junk", () => {
    const id = newOwnerId();
    const v = signOwner(id, SECRET);
    const other = newOwnerId();
    expect(verifyOwner(`${other}${v.slice(v.indexOf("."))}`, SECRET)).toBeNull(); // someone else's id, my signature
    expect(verifyOwner(v.slice(0, -2) + "xx", SECRET)).toBeNull();
    expect(verifyOwner(v, SECRET + "!")).toBeNull();
    for (const junk of ["", "nodot", ".sig", "o-short.sig", `${id}.`, `../${id}.x`]) expect(verifyOwner(junk, SECRET)).toBeNull();
    expect(verifyOwner(null, SECRET)).toBeNull();
  });

  it("is httpOnly, lax, long-lived, and secure only in production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(ownerCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, path: "/" });
    expect(ownerCookieOptions().maxAge).toBeGreaterThanOrEqual(60 * 60 * 24 * 300);
    vi.stubEnv("NODE_ENV", "production");
    expect(ownerCookieOptions().secure).toBe(true);
  });

  it("never hands the session secret or the database URL to the engine, and redacts them in logs", () => {
    vi.stubEnv("AUTOTINKER_SESSION_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@example.invalid/db");
    vi.stubEnv("DATABASE_URL_POOLED", "postgresql://user:pw@pool.example.invalid/db");
    vi.stubEnv("AUTOTINKER_MAX_CONCURRENT", "2");
    const env = engineEnv();
    expect(Object.keys(env)).not.toContain("AUTOTINKER_SESSION_SECRET");
    expect(Object.keys(env).some((k) => k.startsWith("DATABASE"))).toBe(false);
    expect(Object.values(env)).not.toContain(SECRET);
    expect(env.AUTOTINKER_MAX_CONCURRENT).toBe("2");
    expect(knownSecrets()).toEqual(expect.arrayContaining([SECRET, "postgresql://user:pw@example.invalid/db"]));
  });
});
