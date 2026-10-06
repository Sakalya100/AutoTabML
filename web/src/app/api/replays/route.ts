import { listReplays } from "@/lib/replays";

export const runtime = "nodejs";

/** The bundled replays (public/replays/index.json). */
export async function GET() {
  return Response.json({ replays: await listReplays() });
}
