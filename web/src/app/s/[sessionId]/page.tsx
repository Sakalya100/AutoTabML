import type { Metadata } from "next";
import { SessionView } from "@/components/workspace/session-view";
import { liveRunsEnabled } from "@/lib/flags";
import { MAX_EXPERIMENTS_PUBLIC } from "@/lib/upload";

export const metadata: Metadata = { title: "Session" };
export const dynamic = "force-dynamic";

/** A saved session: messages + every run's events from Postgres; a running run resumes over SSE. */
export default async function SessionPage({ params }: PageProps<"/s/[sessionId]">) {
  const { sessionId } = await params;
  return <SessionView key={sessionId} sessionId={sessionId} maxExperiments={MAX_EXPERIMENTS_PUBLIC} liveEnabled={liveRunsEnabled()} />;
}
