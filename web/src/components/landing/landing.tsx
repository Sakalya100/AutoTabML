"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { MotionConfig, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { AnyEvent } from "@/lib/events";
import { fmtDuration } from "@/lib/format";
import { DOCS_URL, GITHUB_URL } from "@/lib/links";
import { buildView } from "@/lib/run-state";
import type { SceneChapter } from "@/lib/scene/contract";
import type { LandingFacts } from "./facts";
import { Hud } from "./hud";
import { Eyebrow, MagneticLink, Reveal, RiseWords } from "./primitives";
import { Rail, type RailItem } from "./rail";
import { ReefStage } from "./reef-stage";
import { useReplayPlayback } from "./use-replay-playback";
import { CeilingViz } from "./viz-ceiling";
import { MutationViz } from "./viz-mutation";
import { NutrientsViz } from "./viz-nutrients";
import { PearlViz } from "./viz-pearl";
import { SelectionViz } from "./viz-selection";

const SECTIONS: RailItem[] = [
  { id: "grow", chapter: "intro", label: "Grow" },
  { id: "nutrients", chapter: "nutrients", label: "Nutrients" },
  { id: "mutation", chapter: "mutation", label: "Mutation" },
  { id: "selection", chapter: "selection", label: "Selection" },
  { id: "ceiling", chapter: "ceiling", label: "Ceiling" },
  { id: "pearl", chapter: "test", label: "Pearl" },
  { id: "ship", chapter: "overview", label: "Ship" },
];

// three.js stays out of the server render and the first paint; the CSS abyss shows until it streams in.
const ReefCanvas = dynamic(() => import("@/components/reef/reef-canvas"), { ssr: false, loading: () => null });

const mq = (q: string) => ({
  sub: (cb: () => void) => {
    const m = window.matchMedia(q);
    m.addEventListener("change", cb);
    return () => m.removeEventListener("change", cb);
  },
  get: () => window.matchMedia(q).matches,
});
const narrowQ = mq("(max-width: 767px)");

export function Landing({ events, facts }: { events: AnyEvent[]; facts: LandingFacts }) {
  const reduced = useReducedMotion() ?? false;
  const narrow = useSyncExternalStore(narrowQ.sub, narrowQ.get, () => false);
  const [active, setActive] = useState(SECTIONS[0].id);
  const chapter: SceneChapter = SECTIONS.find((s) => s.id === active)?.chapter ?? "intro";

  const { view } = useReplayPlayback(events, null, { target: facts.cursors[chapter], loop: true, reduced, speed: 1 });
  const full = useMemo(() => buildView(events), [events]);

  // Active chapter = the section crossing the middle band of the viewport. Plain document scroll; no hijacking.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const els = root.current?.querySelectorAll<HTMLElement>("[data-section]");
    if (!els?.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive((e.target as HTMLElement).id);
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const replayHref = `/replays/${facts.name}`;
  const metricLabel = facts.metric.replace(/_/g, "-").toUpperCase();
  const gainText = facts.keepPair?.gainSe != null && facts.keepPair.p != null ? `kept: gain ${facts.keepPair.gainSe > 0 ? "+" : ""}${facts.keepPair.gainSe.toFixed(2)} SE over ${facts.keepPair.parent.id}, p = ${facts.keepPair.p}` : null;

  return (
    <MotionConfig reducedMotion="user">
      <div ref={root} data-landing className="lp-root" data-theme="dark">
        <ReefStage Reef={ReefCanvas} view={view} full={full} chapter={chapter} quality={narrow ? "lite" : "full"} reduced={reduced} />
        <Rail items={SECTIONS} active={active} />
        <div className="lp-hud-wrap" data-chapter={chapter}>
          <Hud view={view} total={full.experiments.length} compact={narrow} />
        </div>

        {/* 0 — HERO */}
        <section id="grow" data-section className="lp-section lp-hero">
          <div className="lp-col">
            <p className="lp-kicker lp-in" style={{ "--d": "0ms" } as CSSProperties}>
              AutoTabML · self-evolving tabular ML
            </p>
            {/* CSS-only entrance: the headline paints with the HTML, before any JS or three.js. */}
            <h1 className="lp-h1">
              <span className="lp-line">
                <span className="lp-word" style={{ "--d": "60ms" } as CSSProperties}>
                  Models
                </span>{" "}
                <span className="lp-word" style={{ "--d": "140ms" } as CSSProperties}>
                  that
                </span>
              </span>
              <span className="lp-line">
                <span className="lp-word" style={{ "--d": "240ms" } as CSSProperties}>
                  grow
                </span>{" "}
                <span className="lp-word" style={{ "--d": "340ms" } as CSSProperties}>
                  <em className="lp-gold">themselves.</em>
                </span>
              </span>
            </h1>
            <p className="lp-lede lp-in" style={{ "--d": "520ms" } as CSSProperties}>
              AutoTabML evolves a readable ML pipeline, experiment by experiment, keeps only the gains that beat the noise — and stops itself when the
              rest is noise.
            </p>
            <div className="lp-in mt-9 flex flex-wrap items-center gap-3" style={{ "--d": "680ms" } as CSSProperties}>
              <MagneticLink href={replayHref}>Watch a run</MagneticLink>
              <MagneticLink href="/new" variant="ghost">
                Grow your own
              </MagneticLink>
            </div>
            <p className="lp-honest lp-in" style={{ "--d": "900ms" } as CSSProperties}>
              <span className="lp-honest-dot" aria-hidden />
              Replay of a real run · {facts.dataset} · offline heuristic proposer (no LLM)
            </p>
          </div>
          <a href="#nutrients" className="lp-scrollcue" aria-label="Scroll to the story">
            <span>descend</span>
            <span className="lp-scrollcue-line" aria-hidden />
          </a>
        </section>

        {/* 1 — NUTRIENTS */}
        <Chapter id="nutrients" n="01" eyebrow="Nutrients" title="Your data, digested.">
          <p>
            Before a single model runs, the harness profiles the table — types, ranges, skew, missingness, target balance, flags for ID-like or leaky
            columns. The agent sees <strong>this profile and at most {facts.profile?.sampleRows ?? 5} sample rows</strong>. Never the table. Labels for the
            select and test splits never leave the harness.
          </p>
          {facts.profile && (
            <Reveal delay={0.1}>
              <NutrientsViz profile={facts.profile} />
            </Reveal>
          )}
        </Chapter>

        {/* 2 — MUTATION */}
        <Chapter id="mutation" n="02" eyebrow="Mutation" title="One idea, stated before the code.">
          <p>
            Every experiment names its hypothesis first, then edits a single file — <code>solution.py</code> — starting from the current best. Crashes get
            up to three automatic repairs. This is the mutation that grew this run&apos;s winner:
          </p>
          {facts.showcase && (
            <Reveal delay={0.1}>
              <MutationViz showcase={facts.showcase} gainText={gainText} />
            </Reveal>
          )}
        </Chapter>

        {/* 3 — SELECTION */}
        <Chapter id="selection" n="03" eyebrow="Selection" title="Keep, or wither. Noise doesn't get a vote.">
          <p>
            Each child is scored on the <em>same</em> cross-validation folds as its parent, and the gate tests the fold-by-fold differences with a
            Nadeau–Bengio corrected paired t-test. It keeps a change only if p &lt; {facts.gate.alpha ?? 0.1}, the gain is at least{" "}
            {facts.gate.minGainSe ?? 0.5}× the standard error, and a separate select holdout doesn&apos;t get worse.
          </p>
          <p className="text-[color:var(--lp-ink-3)]">
            The second pair is a real child that scored higher on average and still withered: its fold differences straddle zero.
          </p>
          <Reveal delay={0.1}>
            <SelectionViz facts={facts} />
          </Reveal>
        </Chapter>

        {/* 4 — CEILING */}
        <Chapter id="ceiling" n="04" eyebrow="The ceiling" title="It knows when to stop.">
          <p>
            No budget ended this run. After {facts.nExperiments} experiments the light at the surface came into focus: every configured ceiling signal agreed
            that what&apos;s left to find is smaller than the noise.
          </p>
          {facts.stop && (
            <Reveal delay={0.1}>
              <CeilingViz stop={facts.stop} metric={facts.metric} />
            </Reveal>
          )}
        </Chapter>

        {/* 5 — PEARL */}
        <Chapter id="pearl" n="05" eyebrow="The pearl" title="The locked test, opened once.">
          <p>
            A test split the loop never touched is scored exactly once, at the very end. The <strong>optimism gap</strong> — select minus test — tells you how
            much the search fooled itself.
          </p>
          {facts.final && (
            <Reveal delay={0.1}>
              <PearlViz final={facts.final} metric={facts.metric} />
            </Reveal>
          )}
          <p className="text-[14px] text-[color:var(--lp-ink-3)]">
            On {facts.profile?.nRows.toLocaleString("en-US") ?? "a few hundred"} rows a single test split is itself noisy, so a negative gap here is luck, not
            magic. {facts.wallTimeS != null ? `Whole run: ${fmtDuration(facts.wallTimeS)} on a laptop CPU, ${facts.totalCostUsd === 0 ? "$0" : `$${facts.totalCostUsd.toFixed(2)}`}.` : ""}
          </p>
        </Chapter>

        {/* 6 — SHIP */}
        <section id="ship" data-section className="lp-section lp-ship">
          <div className="lp-ship-grid">
            <div>
              <Eyebrow n="06">Ship it</Eyebrow>
              <h2 className="lp-h2 mt-5">
                <RiseWords text="Grow your own." />
              </h2>
              <p className="lp-body mt-5 max-w-[46ch]">
                One command, or three lines of Python. Bring a CSV and a target; AutoTabML brings the harness, the gate and the stopping rule. Plug in an LLM
                for smarter ideas, or run fully offline.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <MagneticLink href="/new">Start a run</MagneticLink>
                <MagneticLink href={GITHUB_URL} variant="ghost" external>
                  GitHub
                </MagneticLink>
              </div>
              <nav className="lp-links mt-8">
                <Link href={replayHref}>Watch this run, step by step</Link>
                <Link href="/replays">All replays</Link>
                <a href={DOCS_URL}>Roadmap &amp; design notes</a>
              </nav>
            </div>
            <Reveal delay={0.1} className="min-w-0">
              <Terminal />
              <ul className="lp-gets mt-6">
                <Get k="solution.py" v="Readable scikit-learn you own — build_pipeline(profile), no magic." />
                <Get k="run.json" v="Every idea, diff, fold score and gate decision. Replayable." />
                <Get k="events.jsonl" v="A typed trace of every step; OpenTelemetry spans optional." />
                <Get k="stop report" v={`Which ceiling signals fired, the locked test score, the optimism gap.`} />
              </ul>
            </Reveal>
          </div>
          <p className="lp-colophon">
            Every number on this page comes from the {facts.name.replace(/_/g, " ")} replay: {facts.nExperiments} experiments, {facts.nKept} kept, stopped by
            the {facts.stop?.reason ?? "stop"} rule. {metricLabel} shown as the metric&apos;s own value.
          </p>
        </section>
      </div>
    </MotionConfig>
  );
}

function Chapter({ id, n, eyebrow, title, children }: { id: string; n: string; eyebrow: string; title: string; children: ReactNode }) {
  const [lede, ...rest] = Array.isArray(children) ? children : [children];
  return (
    <section id={id} data-section className="lp-section">
      <div className="lp-col">
        <Reveal>
          <Eyebrow n={n}>{eyebrow}</Eyebrow>
        </Reveal>
        <h2 className="lp-h2 mt-5">
          <RiseWords text={title} />
        </h2>
        <Reveal delay={0.15} className="lp-body mt-5">
          {lede}
        </Reveal>
        <div className="mt-8 space-y-6">{rest}</div>
      </div>
    </section>
  );
}

function Terminal() {
  return (
    <div className="lp-term">
      <div className="lp-term-bar" aria-hidden>
        <span />
        <span />
        <span />
        <em>shell</em>
      </div>
      <pre>
        <code>
          <span className="lp-c"># offline — no API key needed</span>
          {"\n"}
          <span className="lp-p">$</span> uv run autotabml evolve data.csv --target y{"\n"}
          {"\n"}
          <span className="lp-c"># or let an LLM propose the ideas</span>
          {"\n"}
          <span className="lp-p">$</span> uv run autotabml evolve data.csv --target y \{"\n"}
          {"    "}--llm anthropic:claude-sonnet-5-5 --max-cost 3{"\n"}
        </code>
      </pre>
      <div className="lp-term-sep" />
      <pre>
        <code>
          <span className="lp-k">from</span> autotabml <span className="lp-k">import</span> AutoTabML{"\n"}
          {"\n"}
          run = AutoTabML(llm=<span className="lp-s">&quot;heuristic&quot;</span>).evolve(<span className="lp-s">&quot;data.csv&quot;</span>, target=
          <span className="lp-s">&quot;y&quot;</span>){"\n"}
          run.best.code <span className="lp-c"># the winning solution.py</span>
          {"\n"}
          run.stop_report <span className="lp-c"># why it stopped</span>
          {"\n"}
          run.test_score <span className="lp-c"># the locked holdout, scored once</span>
        </code>
      </pre>
    </div>
  );
}

function Get({ k, v }: { k: string; v: string }) {
  return (
    <li>
      <code>{k}</code>
      <span>{v}</span>
    </li>
  );
}
