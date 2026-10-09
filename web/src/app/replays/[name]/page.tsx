import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RunView } from "@/components/run-view";
import { listReplays, loadReplay } from "@/lib/replays";
import { buildView } from "@/lib/run-state";
import { agentModels, humanName, proposerNote } from "@/lib/story";

export async function generateStaticParams() {
  return (await listReplays()).map((r) => ({ name: r.name }));
}

export async function generateMetadata({ params }: PageProps<"/replays/[name]">): Promise<Metadata> {
  const { name } = await params;
  const info = (await listReplays()).find((r) => r.name === name);
  return { title: info ? `${humanName(info.name)}: a recorded run` : "Replay" };
}

export default async function ReplayPage({ params, searchParams }: PageProps<"/replays/[name]">) {
  const { name } = await params;
  const sp = await searchParams;
  const data = await loadReplay(name);
  if (!data) notFound();
  const { info, record, events } = data;
  const others = (await listReplays()).filter((r) => r.name !== name && !r.fixture).map((r) => ({ name: r.name }));
  return (
    <RunView
      mode="replay"
      events={events}
      record={record}
      initialSimulate={sp.simulate !== undefined}
      title={humanName(info.name)}
      kicker="A recorded run"
      note={
        info.fixture ? (
          "A hand-written example, not a recorded engine run."
        ) : info.selection ? (
          // The model note the page would show anyway, then how this run was picked from several recordings.
          <>
            {proposerNote(record.proposer ?? info.proposer, agentModels(buildView(events, record)))} {info.selection}
          </>
        ) : undefined
      }
      others={others}
    />
  );
}
