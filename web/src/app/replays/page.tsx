import type { Metadata } from "next";
import Link from "next/link";
import { listReplays } from "@/lib/replays";

export const metadata: Metadata = { title: "Replays" };

export default async function ReplaysPage() {
  const replays = await listReplays();
  return (
    <main className="mx-auto max-w-[920px] px-4 pt-12 pb-20 sm:px-6">
      <h1 className="font-display text-5xl leading-none tracking-tight">Replays</h1>
      <p className="mt-3 max-w-[60ch] text-ink-2">
        Complete runs, recorded event by event. Press play to watch the agent propose, test, keep or discard, and finally decide it has hit the
        ceiling.
      </p>
      <ul className="mt-10 divide-y divide-rule border-y border-rule">
        {replays.map((r) => (
          <li key={r.name}>
            <Link href={`/replays/${r.name}`} className="group grid gap-1 py-5 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <div className="font-display text-2xl leading-tight group-hover:text-best">{r.title}</div>
                <div className="mt-1 text-sm text-ink-2">{r.blurb}</div>
              </div>
              <div className="font-mono text-xs text-ink-3 sm:text-right">
                {r.dataset}
                <br />
                {r.n_experiments} experiments · {r.metric} · stopped: {r.stop_reason}
              </div>
            </Link>
          </li>
        ))}
        {replays.length === 0 && <li className="py-8 text-ink-3">No replays are bundled with this build.</li>}
      </ul>
    </main>
  );
}
