import type { NextConfig } from "next";

/**
 * The API is a separate FastAPI service (backend/). On Vercel the root vercel.json routes /api/* to it, so the app
 * calls same-origin /api/* everywhere. In `next dev` this rewrite proxies /api/* to the local backend instead
 * (AUTOTINKER_API_URL, default http://127.0.0.1:8000). It is dev-only: production builds don't carry it.
 */
const apiUrl = (process.env.AUTOTINKER_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  // Replays are read from public/replays with fs at request time; public/ is served by the CDN and is not
  // traced into serverless functions by default, so include it explicitly for the routes that read it.
  outputFileTracingIncludes: {
    "/replays/*": ["./public/replays/**/*"],
    "/": ["./public/replays/**/*"],
  },
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    return { beforeFiles: [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }], afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
