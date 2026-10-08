import type { Metadata } from "next";
import { LiveRun } from "@/components/live-run";

export const metadata: Metadata = { title: "Live run" };
export const dynamic = "force-dynamic";

/**
 * A run by id. Every run belongs to a session, so LiveRun forwards to /s/<session> once the API (which checks that the
 * run is yours) answers; another browser's run looks like a missing one.
 */
export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  return <LiveRun id={id} />;
}
