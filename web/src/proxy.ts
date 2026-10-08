import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Clerk keeps its session cookie fresh on page requests. Without a Clerk key (auth off) this is a pass-through.
// /api is left out: it goes to the FastAPI backend, which verifies the same `__session` cookie itself.
export default process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: ["/((?!api|_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)"],
};
