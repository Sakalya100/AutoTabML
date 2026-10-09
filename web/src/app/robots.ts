import type { MetadataRoute } from "next";

/** Crawlers welcome on the public pages; the workspace and API are per-account. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/s/", "/api/"] },
    host: "https://autotinker.sakalya.si",
  };
}
