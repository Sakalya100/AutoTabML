import Link from "next/link";
import { landingFacts } from "@/components/landing/facts";
import { Landing } from "@/components/landing/landing";
import { loadReplay } from "@/lib/replays";

/** The landing story is told with one real recorded run. */
const STORY_REPLAY = "breast_cancer";

export default async function Home() {
  const replay = await loadReplay(STORY_REPLAY);
  if (!replay) {
    // Never fake a run: without the replay files there is no story to tell, only the way in.
    return (
      <main className="mx-auto max-w-[1240px] px-4 py-24 sm:px-6">
        <h1 className="font-display text-[clamp(2.75rem,6vw,5rem)] leading-[0.95]">
          Models that tinker <span className="text-best italic">themselves.</span>
        </h1>
        <p className="mt-6 max-w-[54ch] text-lg text-ink-2">
          AutoTinker evolves a readable ML pipeline, experiment by experiment, until the gains are just noise.
        </p>
        <div className="mt-8 flex gap-3">
          <Link href="/replays" className="rounded-full bg-ink px-6 py-3 text-paper">
            Replays
          </Link>
          <Link href="/s/new" className="rounded-full border border-rule-strong px-6 py-3">
            New run
          </Link>
        </div>
      </main>
    );
  }
  const p = replay.record.profile;
  const dataset = p ? `${STORY_REPLAY.replace(/_/g, " ")} · ${p.n_rows.toLocaleString("en-US")} rows · ${p.n_cols - 1} features` : replay.info.dataset;
  const facts = landingFacts(replay.info.name, dataset, replay.events, replay.record);
  // Only the event stream goes to the client (the survey world replays it); code and diffs stay on the server.
  return <Landing events={replay.events} facts={facts} />;
}
