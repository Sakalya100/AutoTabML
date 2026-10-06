import type { Metadata } from "next";
import { ReplayGallery, type GalleryItem } from "@/components/replay-gallery";
import { columnKinds, reefSummary } from "@/components/reef/describe";
import { formatScore, metricInfo } from "@/lib/metrics";
import { listReplays, loadReplay } from "@/lib/replays";
import { buildView } from "@/lib/run-state";
import { layoutReef } from "@/lib/scene/layout";

export const metadata: Metadata = { title: "Replays" };

export default async function ReplaysPage() {
  const replays = await listReplays();
  // Layouts are pure and small, so they are computed here; the client never receives code, diffs or events.
  const items: GalleryItem[] = [];
  for (const info of replays) {
    const data = await loadReplay(info.name);
    if (!data) continue;
    const view = buildView(data.events, data.record);
    const best = view.experiments.find((x) => x.id === view.bestId);
    items.push({
      info,
      layout: layoutReef(view),
      phase: view.phase,
      kinds: columnKinds(view),
      summary: reefSummary(view),
      metricLabel: metricInfo(view.metric ?? info.metric).label,
      best: best?.cv ? formatScore(view.metric, best.cv.mean) : null,
      test: view.final ? formatScore(view.metric, view.final.testScore) : null,
      kept: view.experiments.filter((x) => x.status === "keep").length,
    });
  }
  return (
    <main className="mx-auto max-w-[1240px] px-4 pt-12 pb-20 sm:px-6">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] md:items-end">
        <h1 className="font-display text-[clamp(3rem,7vw,5.5rem)] leading-[0.9] tracking-tight">
          A gallery of <span className="italic text-best">reefs</span>
        </h1>
        <p className="max-w-[52ch] text-ink-2 md:justify-self-end">
          Complete runs, recorded event by event. Each reef grew one experiment at a time — kept ideas glow and keep climbing, discarded ones
          wither, and the run stops when it touches the fitted ceiling. Open one to watch it grow.
        </p>
      </div>
      {items.length ? (
        <ReplayGallery items={items} />
      ) : (
        <p className="mt-12 border-y border-rule py-8 text-ink-3">No replays are bundled with this build.</p>
      )}
    </main>
  );
}
