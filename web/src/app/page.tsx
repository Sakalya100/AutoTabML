import Link from "next/link";
import { HeroReplay } from "@/components/hero-replay";
import { DOCS_URL, GITHUB_URL } from "@/lib/links";
import { listReplays, loadReplay } from "@/lib/replays";

const STEPS = [
  {
    k: "Harness",
    h: "A fixed arena the agent can't touch",
    p: "Data is split once into dev, select and a locked test set. Every experiment runs in a sandbox with a timeout, a memory cap and no network, and is scored with repeated k-fold CV. The agent never reads the data — only a profile and five sample rows.",
  },
  {
    k: "Agent",
    h: "One idea, stated before the code",
    p: "Each step names a hypothesis — “add petal area”, “try a random forest” — then edits a single file, solution.py, starting from the current best. Crashes get up to three automatic repairs.",
  },
  {
    k: "Gate",
    h: "Keep only gains that beat the noise",
    p: "A change survives only if a paired test across the same folds says it is real, the gain is at least half a standard error, and the separate select holdout agrees. A simpler solution that scores the same also wins.",
  },
  {
    k: "Ceiling",
    h: "Stop when more searching is just noise",
    p: "The run ends itself when recent gains are under the noise floor, a fitted saturation curve predicts nothing left, and several radical attempts have failed. Then the locked test is scored once and the optimism gap is reported.",
  },
];

export default async function Home() {
  const replays = await listReplays();
  const first = replays[0] ? await loadReplay(replays[0].name) : null;
  const href = first ? `/replays/${first.info.name}` : "/replays";

  return (
    <main>
      <section className="mx-auto grid max-w-[1240px] grid-cols-[minmax(0,1fr)] items-center gap-10 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)] lg:pt-20">
        <div className="rise">
          <p className="text-sm tracking-wide text-ink-3">Autoresearch for tabular ML</p>
          <h1 className="mt-4 font-display text-[clamp(2.75rem,6.4vw,5.25rem)] leading-[0.95] tracking-[-0.015em]">
            An agent that improves its own ML pipeline — <span className="text-best italic">and knows when to stop.</span>
          </h1>
          <p className="mt-6 max-w-[54ch] text-lg leading-relaxed text-ink-2">
            AutoTabML evolves readable scikit-learn code for your table, keeps only statistically real gains, stops at the problem&apos;s ceiling, and
            tells you how much the search overfit.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href={href} className="rounded-full bg-ink px-6 py-3 text-[15px] font-medium text-paper transition-opacity hover:opacity-90">
              Watch a replay
            </Link>
            <Link href="/new" className="rounded-full border border-rule-strong px-6 py-3 text-[15px] transition-colors hover:border-ink">
              Try your own CSV
            </Link>
          </div>
        </div>
        {first && (
          <div className="rise [animation-delay:150ms]">
            <HeroReplay name={first.info.name} events={first.events} record={first.record} />
          </div>
        )}
      </section>

      <section className="border-t border-rule">
        <div className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6">
          <h2 className="max-w-[24ch] font-display text-[clamp(2rem,3.6vw,2.75rem)] leading-tight">How a run works, in four parts</h2>
          <ol className="mt-10 grid gap-x-12 gap-y-10 md:grid-cols-2">
            {STEPS.map((s, i) => (
              <li key={s.k} className="grid grid-cols-[3rem_1fr] gap-x-2 border-t border-rule pt-5">
                <span className="font-display text-4xl leading-none text-best italic">{i + 1}</span>
                <div>
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-ink-3">{s.k}</div>
                  <h3 className="mt-1 font-display text-2xl leading-snug">{s.h}</h3>
                  <p className="mt-2 max-w-[56ch] leading-relaxed text-ink-2">{s.p}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-t border-rule bg-paper-2">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-end justify-between gap-6 px-4 py-14 sm:px-6">
          <div className="max-w-[60ch]">
            <h2 className="font-display text-3xl leading-tight">Readable code you own, and a record of everything it tried.</h2>
            <p className="mt-3 text-ink-2">
              Every experiment&apos;s idea, diff, fold scores and gate decision is kept. The engine is an open-source Python package with a CLI; this
              site is a client of its event stream.
            </p>
          </div>
          <div className="flex gap-5 text-[15px]">
            <a href={GITHUB_URL} className="underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
              GitHub
            </a>
            <a href={DOCS_URL} className="underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
              Design notes
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
