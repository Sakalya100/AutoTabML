import { NextResponse, type NextRequest } from "next/server";
import { newOwnerId, OWNER_COOKIE, ownerCookieOptions, signOwner, verifyOwner } from "@/lib/identity";

/**
 * Mints the anonymous owner cookie on the first visit to the workspace or its APIs, so every page and route handler
 * in the same request already sees a valid identity (one owner per browser, no race between parallel first calls).
 */
export function proxy(request: NextRequest) {
  if (verifyOwner(request.cookies.get(OWNER_COOKIE)?.value)) return NextResponse.next();
  const value = signOwner(newOwnerId());
  request.cookies.set(OWNER_COOKIE, value);
  const headers = new Headers(request.headers);
  headers.set("cookie", request.cookies.toString());
  const res = NextResponse.next({ request: { headers } });
  res.cookies.set(OWNER_COOKIE, value, ownerCookieOptions());
  return res;
}

export const config = {
  matcher: ["/s", "/s/:path*", "/runs/:path*", "/api/sessions/:path*", "/api/sessions", "/api/runs/:path*", "/api/runs"],
};
