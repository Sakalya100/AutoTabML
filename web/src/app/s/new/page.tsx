import type { Metadata } from "next";
import { SessionView } from "@/components/workspace/session-view";
import { liveRunsEnabled } from "@/lib/runner";
import { MAX_EXPERIMENTS_PUBLIC } from "@/lib/upload";

export const metadata: Metadata = { title: "New session" };
export const dynamic = "force-dynamic";

export default function NewSessionPage() {
  return <SessionView key="new" sessionId={null} maxExperiments={MAX_EXPERIMENTS_PUBLIC} liveEnabled={liveRunsEnabled()} />;
}
