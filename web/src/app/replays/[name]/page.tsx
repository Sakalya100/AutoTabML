import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RunView } from "@/components/run-view";
import { listReplays, loadReplay } from "@/lib/replays";

export async function generateStaticParams() {
  return (await listReplays()).map((r) => ({ name: r.name }));
}

export async function generateMetadata({ params }: PageProps<"/replays/[name]">): Promise<Metadata> {
  const { name } = await params;
  const info = (await listReplays()).find((r) => r.name === name);
  return { title: info ? `Replay: ${info.title}` : "Replay" };
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
      autoplay={sp.at !== "end"}
      title={info.title}
      subtitle={
        <span className="text-sm">
          {info.dataset} · target <span className="font-mono">{record.task.target}</span>
          {info.fixture && (
            <>
              {" "}
              · <span title={info.blurb}>hand-written fixture, not a recorded engine run</span>
            </>
          )}
          {" · "}
          <Link href={`/replays/${name}?at=end`} className="underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
            skip to the end
          </Link>
        </span>
      }
    />
  );
}
