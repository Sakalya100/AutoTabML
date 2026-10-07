import { jsonError } from "@/lib/api";
import { PreviewError } from "@/lib/ingest/ssrf";
import { cachedPreview, suggestFor } from "@/lib/ingest/preview-service";
import { clientIp, previewLimiter } from "@/lib/rate-limit";
import { serverEnv } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_URL = 2048;
const MAX_GOAL = 500;

/**
 * Preview a public CSV link. Body: {url, goal?}. Returns the header, inferred column kinds, a ≤ 50-row sample (for
 * display only), the row count (exact or estimated), the direct download URL and suggestions for target/type/metric.
 */
export async function POST(req: Request) {
  let body: { url?: unknown; goal?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "Send JSON: {url, goal?}.");
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const goal = typeof body.goal === "string" ? body.goal.trim().slice(0, MAX_GOAL) : "";
  if (!url) return jsonError(400, "Paste a link to a CSV file.", { field: "url", code: "invalid_url" });
  if (url.length > MAX_URL) return jsonError(400, "That link is too long.", { field: "url", code: "invalid_url" });

  const rl = previewLimiter().check(clientIp(req));
  if (!rl.ok)
    return jsonError(429, `Too many previews in a minute. Try again in ${rl.retryAfterS} s.`, { code: "rate_limited" }, { "Retry-After": String(rl.retryAfterS) });

  try {
    const preview = await cachedPreview(url);
    const { suggestion, llm } = await suggestFor(preview, goal, {
      groqKey: serverEnv("GROQ_API_KEY"),
      geminiKey: serverEnv("GEMINI_API_KEY"),
      timeoutMs: 8000,
    });
    return Response.json({ preview, suggestion, llm }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof PreviewError) return jsonError(422, err.message, { field: "url", code: err.code });
    console.error("[preview] unexpected error", (err as Error).message);
    return jsonError(500, "Something went wrong reading that link. Try again, or upload the file instead.", { field: "url", code: "internal" });
  }
}
