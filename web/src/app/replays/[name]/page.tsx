import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RunView } from "@/components/run-view";
import { listReplays, loadReplay } from "@/lib/replays";
import { humanName } from "@/lib/story";

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
  return (
    <RunView
      mode="replay"
      events={events}
      record={record}
      initialSimulate={sp.simulate !== undefined}
      title={humanName(info.name)}
      kicker="A recorded run"
      note={info.fixture ? "A hand-written example, not a recorded engine run." : undefined}
    />
  );
}
