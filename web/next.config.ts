import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Replays are read from public/replays with fs at request time; public/ is served by the CDN and is not
  // traced into serverless functions by default, so include it explicitly for the routes that read it.
  outputFileTracingIncludes: {
    "/replays/*": ["./public/replays/**/*"],
    "/api/replays": ["./public/replays/**/*"],
    "/": ["./public/replays/**/*"],
  },
};

export default nextConfig;
