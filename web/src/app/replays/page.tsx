import type { Metadata } from "next";
import { GalleryHead, ReplayGallery, type GalleryItem } from "@/components/replay-gallery";
import { metricInfo } from "@/lib/metrics";
import { listReplays, loadReplay } from "@/lib/replays";
import { buildView } from "@/lib/run-state";
import { askedOf, displayScore, humanName, outcomeLine, outcomeOf, proposerNote } from "@/lib/story";
import { slimView, surveySummary } from "@/lib/terra";

export const metadata: Metadata = { title: "Replays" };

export default async function ReplaysPage() {
  const replays = await listReplays();
  // Views are slimmed here, so the client never receives code, diffs, rationale or events.
  const loaded: { item: Omit<GalleryItem, "note">; proposer: string | null }[] = [];
  for (const info of replays) {
    const data = await loadReplay(info.name);
    if (!data) continue;
    const view = buildView(data.events, data.record);
    const a = askedOf(view);
    loaded.push({
      proposer: view.proposer ?? info.proposer ?? null,
      item: {
        name: info.name,
        title: humanName(info.name),
        view: slimView(view),
        summary: surveySummary(view),
        outcome: outcomeLine(outcomeOf(view)),
        asked:
          a.target && a.rows != null && a.features != null
            ? `Predicts “${a.target}”${a.kind ? ` (${a.kind})` : ""} from ${a.features} columns of ${a.rows.toLocaleString("en-US")} rows.`
            : null,
        test: view.final ? displayScore(view.metric, view.final.testScore) : null,
        metricLabel: metricInfo(view.metric ?? info.metric).label,
        nExperiments: view.experiments.length,
        selection: info.selection ?? null,
      },
    });
  }
  // The honest proposer note, once: on the page when every run shares it, otherwise on each run that needs one.
  const shared = loaded.length > 0 && loaded.every((l) => l.proposer === loaded[0].proposer) ? proposerNote(loaded[0].proposer) : null;
  const items: GalleryItem[] = loaded.map((l) => ({ ...l.item, note: shared ? null : proposerNote(l.proposer) }));
  const words = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
  const count = items.length < words.length ? words[items.length] : String(items.length);

  return (
    <main data-terra className="rp-root">
      <GalleryHead
        sub={
          <>
            <p className="lp-sub at-sub">
              {count} real run{items.length === 1 ? "" : "s"}, seen from above. Higher ground is a better model, and the amber trail is the path of ideas each
              one kept.
            </p>
            {shared && <p className="rp-note">{shared}</p>}
          </>
        }
      >
        Every run leaves a <em>map.</em>
      </GalleryHead>
      {items.length ? <ReplayGallery items={items} /> : <p className="rp-wrap lp-sub pb-24">No replays are bundled with this build.</p>}
    </main>
  );
}
