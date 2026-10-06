import type { Metadata } from "next";
import { ReplayGallery, type GalleryItem } from "@/components/replay-gallery";
import { formatScore, metricInfo } from "@/lib/metrics";
import { listReplays, loadReplay } from "@/lib/replays";
import { buildView } from "@/lib/run-state";
import { slimView, surveySummary } from "@/lib/terra";

export const metadata: Metadata = { title: "Replays" };

export default async function ReplaysPage() {
  const replays = await listReplays();
  // Views are slimmed here, so the client never receives code, diffs, rationale or events.
  const items: GalleryItem[] = [];
  for (const info of replays) {
    const data = await loadReplay(info.name);
    if (!data) continue;
    const view = buildView(data.events, data.record);
    const best = view.experiments.find((x) => x.id === view.bestId);
    items.push({
      info,
      view: slimView(view),
      summary: surveySummary(view),
      metricLabel: metricInfo(view.metric ?? info.metric).label,
      best: best?.cv ? formatScore(view.metric, best.cv.mean) : null,
      test: view.final ? formatScore(view.metric, view.final.testScore) : null,
      kept: view.experiments.filter((x) => x.status === "keep").length,
    });
  }
  return (
    <main data-terra className="mx-auto max-w-[1240px] px-4 pt-14 pb-24 sm:px-6">
      <div className="rise grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] md:items-end">
        <h1 className="font-display text-[clamp(3rem,7vw,5.5rem)] leading-[0.9] tracking-tight">
          Mapped <span className="italic text-best">lands</span>
        </h1>
        <p className="max-w-[50ch] text-ink-2 md:justify-self-end">
          Complete runs, recorded event by event and seen from straight above. Every probe is an experiment, its height the CV score; the contours
          are the land the agent mapped before it stopped under the ceiling. Open one to watch it surveyed.
        </p>
      </div>
      {items.length ? <ReplayGallery items={items} /> : <p className="mt-12 border-y border-rule py-8 text-ink-3">No replays are bundled with this build.</p>}
    </main>
  );
}
