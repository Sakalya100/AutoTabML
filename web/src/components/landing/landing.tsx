"use client";

/*
 * Landing — design rules, distilled from Apple's AirPods Pro and Vision Pro pages and Linear's homepage:
 *  1. One message per viewport. Each screen says one thing; detail lives one click away ("See the full run →").
 *  2. A single centered column. No text|visual split, no side rails, no floating HUD — the tree IS the visual.
 *  3. Headlines of 3–7 words in a big display serif, with at most one short subline under them.
 *  4. Pin, then scrub: the "watch it grow" story is a sticky section whose scroll progress drives the real replay
 *     forward and backward; one caption at a time crossfades in sync.
 *  5. Big typographic number moments ("23 million pixels") — here the run's own numbers, one per screen.
 *  6. Progressive disclosure: every idea gets one sentence and a quiet "Learn more", never a chart wall.
 *  7. Generous negative space (~120–200px between sections), text measure ≤ 640px.
 *  8. Calm motion: transform/opacity only, scroll-linked rather than timed, nothing that loops for attention;
 *     prefers-reduced-motion gets static sections over the finished tree.
 *  9. Minimal chrome: two CTAs at the top, the same two at the end, nothing competing in between.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { MotionConfig, motion, useMotionValueEvent, useScroll, useTransform, type MotionValue } from "motion/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { AnyEvent } from "@/lib/events";
import { DOCS_URL, GITHUB_URL } from "@/lib/links";
import { formatScore, metricInfo } from "@/lib/metrics";
import { buildView } from "@/lib/run-state";
import type { SceneChapter } from "@/lib/scene/contract";
import type { LandingFacts } from "./facts";
import { MagneticLink, Reveal, RiseWords, Ticker } from "./primitives";
import { ReefStage } from "./reef-stage";
import { useReplayPlayback } from "./use-replay-playback";

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
const reducedQ = mq("(prefers-reduced-motion: reduce)");

/* ---- a tiny external store: scroll writes it, only the reef and the live numbers read it ---- */

interface StageState {
  /** Replay cursor to hold; null = autoplay (the hero grows the run once and holds it). */
  target: number | null;
  /** Index into facts.growth for the live numbers. */
  step: number;
  chapter: SceneChapter;
}

function createStageStore(init: StageState) {
  let s = init;
  const ls = new Set<() => void>();
  return {
    get: () => s,
    set(p: Partial<StageState>) {
      const n = { ...s, ...p };
      if (n.target === s.target && n.step === s.step && n.chapter === s.chapter) return;
      s = n;
      ls.forEach((l) => l());
    },
    sub(l: () => void) {
      ls.add(l);
      return () => {
        ls.delete(l);
      };
    },
  };
}
type StageStore = ReturnType<typeof createStageStore>;

/**
 * The reef reads the store here, so a scroll step re-renders this layer only — never the page.
 * Scrubbing changes the cursor at most once per experiment (~40 states across the whole pin).
 */
function StageLayer({ events, full, store, narrow, reduced }: { events: AnyEvent[]; full: ReturnType<typeof buildView>; store: StageStore; narrow: boolean; reduced: boolean }) {
  const target = useSyncExternalStore(store.sub, () => store.get().target, () => null);
  const chapter = useSyncExternalStore(store.sub, () => store.get().chapter, () => "overview" as SceneChapter);
  const { view } = useReplayPlayback(events, null, { target, loop: false, reduced, jump: true, speed: 1.5 });
  return <ReefStage Reef={ReefCanvas} view={view} full={full} chapter={chapter} quality={narrow ? "lite" : "full"} autoRotate={!reduced} />;
}

function useStep(store: StageStore) {
  return useSyncExternalStore(store.sub, () => store.get().step, () => 0);
}

/* ---- page ---- */

export function Landing({ events, facts }: { events: AnyEvent[]; facts: LandingFacts }) {
  // Not useReducedMotion(): it reads the media query during the first render, which then disagrees with the
  // server HTML (the pinned section and the static one are different markup) and breaks hydration.
  const reduced = useSyncExternalStore(reducedQ.sub, reducedQ.get, () => false);
  const narrow = useSyncExternalStore(narrowQ.sub, narrowQ.get, () => false);
  const full = useMemo(() => buildView(events), [events]);
  const [store] = useState(() => createStageStore({ target: null, step: 0, chapter: "overview" }));

  const root = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Each section declares how present the tree is behind it (and which camera framing it wants).
  // Written straight to the DOM / store: crossing a section never re-renders the page.
  useEffect(() => {
    const els = root.current?.querySelectorAll<HTMLElement>("[data-stage]");
    if (!els?.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          stageRef.current?.setAttribute("data-presence", el.dataset.stage ?? "full");
          store.set({ chapter: (el.dataset.chapter as SceneChapter | undefined) ?? "overview" });
        }
      },
      { rootMargin: "-48% 0px -48% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [store]);

  // Hero: as it scrolls away the copy lifts and fades, and the tree rises from below the headline to center.
  const hero = useRef<HTMLElement>(null);
  const { scrollYProgress: heroP } = useScroll({ target: hero, offset: ["start start", "end start"] });
  const stageY = useTransform(heroP, [0, 1], reduced ? ["0vh", "0vh"] : [narrow ? "20vh" : "13vh", "0vh"]);
  const copyY = useTransform(heroP, [0, 1], [0, reduced ? 0 : -90]);
  const copyOpacity = useTransform(heroP, [0, 0.55], [1, reduced ? 1 : 0]);
  const copyScale = useTransform(heroP, [0, 1], [1, reduced ? 1 : 0.94]);

  const replayHref = `/replays/${facts.name}`;
  const proposerLine = facts.proposer === "heuristic" ? "offline heuristic proposer (no LLM)" : `proposer: ${facts.proposer}`;

  return (
    <MotionConfig reducedMotion="user">
      <div ref={root} data-landing className="lp-root" data-theme="dark">
        <div ref={stageRef} className="lp-stage-wrap" data-presence="full">
          <motion.div className="lp-stage-move" style={{ y: stageY }}>
            <StageLayer events={events} full={full} store={store} narrow={narrow} reduced={reduced} />
          </motion.div>
        </div>

        {/* 1 — HERO: one headline, one line, two doors. */}
        <section ref={hero} className="lp-section lp-hero" data-stage="full" data-chapter="overview">
          <motion.div className="lp-hero-copy" style={{ y: copyY, opacity: copyOpacity, scale: copyScale }}>
            {/* CSS-only entrance: the headline paints with the HTML, before any JS or three.js. */}
            <h1 className="lp-h1">
              {["Models", "that", "grow"].map((w, i) => (
                <span key={w}>
                  <span className="lp-word" style={{ "--d": `${80 + i * 90}ms` } as CSSProperties}>
                    {w}
                  </span>{" "}
                </span>
              ))}
              <span className="lp-word" style={{ "--d": "350ms" } as CSSProperties}>
                <em className="lp-gold">themselves.</em>
              </span>
            </h1>
            <p className="lp-sub lp-in lp-measure" style={{ "--d": "560ms", maxWidth: "36ch" } as CSSProperties}>
              AutoTabML evolves a readable ML pipeline, keeps only what beats the noise, and knows when to stop.
            </p>
            <div className="lp-ctas lp-in" style={{ "--d": "700ms" } as CSSProperties}>
              <MagneticLink href={replayHref}>Watch a run</MagneticLink>
              <MagneticLink href="/new" variant="ghost">
                Grow your own
              </MagneticLink>
            </div>
          </motion.div>
          <p className="lp-honest lp-in" style={{ "--d": "1000ms" } as CSSProperties}>
            <span className="lp-honest-dot" aria-hidden />
            Replay of a real run · {proposerLine}
          </p>
        </section>

        {/* 2 — WATCH IT GROW: pinned; scroll scrubs the real replay. */}
        <Growth facts={facts} store={store} reduced={reduced} />

        {/* 3 — the typographic moment */}
        <Statement facts={facts} reduced={reduced} />

        {/* 4 — the locked test */}
        <section className="lp-section lp-test" data-stage="full" data-chapter="test">
          <div className="lp-measure">
            <h2 className="lp-h2">
              <RiseWords text="A test it never sees." />
            </h2>
            <Reveal delay={0.2}>
              <p className="lp-sub">One split stays locked for the whole run. It is scored once, at the very end.</p>
            </Reveal>
          </div>
          {facts.final && (
            <Reveal className="lp-stat" delay={0.1}>
              <span className="lp-stat-v">{formatScore(facts.metric, facts.final.test)}</span>
              <span className="lp-stat-k">{metricInfo(facts.metric).label} on the locked test</span>
              <span className="lp-stat-k" style={{ color: "var(--lp-ink-3)" }}>
                Optimism gap: {facts.final.gapText}.
              </span>
            </Reveal>
          )}
        </section>

        {/* 5 — three ideas, stacked */}
        <section className="lp-section lp-ideas" data-stage="faint" data-chapter="overview">
          <Idea title="Sandboxed." more={{ href: `${GITHUB_URL}#how-it-works`, label: "How the harness works" }}>
            Every experiment runs in its own process: no network, no secrets, hard limits.
          </Idea>
          <Idea title="Statistically honest." more={{ href: replayHref, label: "See every decision" }}>
            A change survives only if it wins a corrected paired t-test on the same folds as its parent.
          </Idea>
          <Idea title="Code you own." more={{ href: DOCS_URL, label: "Read the design notes" }}>
            The result is one readable scikit-learn file, plus a replayable record of every step.
          </Idea>
        </section>

        {/* 6 — start */}
        <section className="lp-section" data-stage="faint" data-chapter="overview">
          <h2 className="lp-h2">
            <RiseWords text="Three lines to start." />
          </h2>
          <Reveal delay={0.15} className="w-full">
            <pre className="lp-code">
              <code>
                <span className="lp-k">from</span> autotabml <span className="lp-k">import</span> AutoTabML{"\n"}
                run = AutoTabML().evolve(<span className="lp-s">&quot;data.csv&quot;</span>, target=<span className="lp-s">&quot;y&quot;</span>){"\n"}
                run.best.code <span className="lp-c"># the winning solution.py</span>
              </code>
            </pre>
            <p className="lp-shell">
              Or from the shell: <code>uv run autotabml evolve data.csv --target y</code>
              <br />
              Offline by default — no API key needed.
            </p>
          </Reveal>
        </section>

        {/* 7 — close */}
        <section className="lp-section lp-close" data-stage="dim" data-chapter="overview">
          <h2 className="lp-h2">
            <RiseWords text="Grow your own." />
          </h2>
          <Reveal delay={0.2}>
            <div className="lp-ctas">
              <MagneticLink href="/new">Start a run</MagneticLink>
              <MagneticLink href={replayHref} variant="ghost">
                See the full run
              </MagneticLink>
            </div>
            <nav className="lp-links" aria-label="More">
              <Link href="/replays">All replays</Link>
              <a href={GITHUB_URL}>GitHub</a>
              <a href={DOCS_URL}>Roadmap</a>
            </nav>
          </Reveal>
          <p className="lp-colophon">
            Every number on this page comes from the {facts.name.replace(/_/g, " ")} replay ({facts.nExperiments} experiments, {facts.nKept} kept).
          </p>
        </section>
      </div>
    </MotionConfig>
  );
}

/* ---- 2: the pinned growth sequence ---- */

interface Beat {
  title: string;
  /** `done`: the static (reduced-motion) view, which only ever shows the finished run. */
  stat: (step: number, done?: boolean) => { v: ReactNode; k: string };
}

function beatsFor(facts: LandingFacts): Beat[] {
  const total = facts.nExperiments;
  const label = metricInfo(facts.metric).label;
  const at = (i: number) => facts.growth[Math.min(i, facts.growth.length - 1)];
  return [
    {
      title: "It states an idea.",
      stat: (i) => ({
        v: (
          <>
            <Ticker value={at(i).n} format={(n) => String(Math.round(n)).padStart(2, "0")} />
            <span className="lp-stat-dim"> / {total}</span>
          </>
        ),
        k: "experiments, one hypothesis each",
      }),
    },
    {
      title: "Tests it in a sandbox.",
      stat: (i, done) => ({
        v: <Ticker value={at(i).best} format={(n) => formatScore(facts.metric, n)} />,
        k: `best cross-validated ${label}${done ? "" : " so far"}`,
      }),
    },
    {
      title: "Keeps only what beats the noise.",
      stat: (i) => ({
        v: (
          <>
            <span style={{ color: "var(--lp-keep)" }}>
              <Ticker value={at(i).kept} format={(n) => String(Math.round(n))} />
            </span>
            <span className="lp-stat-dim"> kept</span>
          </>
        ),
        k: `of ${at(i).n} tried — the rest withered`,
      }),
    },
    {
      title: facts.stop?.reason === "ceiling" ? "Stops when the rest is noise." : "Stops at its budget.",
      stat: () =>
        facts.stop && facts.stop.signals > 0
          ? { v: `${facts.stop.fired} / ${facts.stop.signals}`, k: "ceiling signals agreed — no budget ran out" }
          : { v: String(total), k: "experiments in all" },
    },
  ];
}

/** Scroll progress range [start, end) of each beat; the cursor runs over SCRUB. */
const BEAT_AT = [0, 0.26, 0.5, 0.74, 1];
const SCRUB: [number, number] = [0.03, 0.9];

function Growth({ facts, store, reduced }: { facts: LandingFacts; store: StageStore; reduced: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const beats = beatsFor(facts);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.5", "end end"] });
  const g = facts.growth;

  const apply = (v: number) => {
    if (reduced) return;
    if (v <= 0) return store.set({ target: null, step: 0 });
    if (v >= 1) return store.set({ target: facts.end, step: g.length - 1 });
    const t = Math.min(1, Math.max(0, (v - SCRUB[0]) / (SCRUB[1] - SCRUB[0])));
    const i = Math.round(t * (g.length - 1));
    store.set({ target: g[i].cursor, step: i });
  };
  useMotionValueEvent(scrollYProgress, "change", apply);
  // A reload mid-page restores the scroll position without a change event.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  useEffect(() => apply(scrollYProgress.get()), []);

  if (reduced) {
    return (
      <section className="lp-beats-static" data-stage="full" data-chapter="overview" aria-label="Watch it grow">
        {beats.map((b, i) => (
          <div key={i} className="lp-beat">
            <h2 className="lp-h2">{b.title}</h2>
            <BeatStat beat={b} step={g.length - 1} done />
          </div>
        ))}
      </section>
    );
  }

  return (
    <section ref={ref} className="lp-pin" data-stage="full" data-chapter="overview" aria-label="Watch it grow">
      <div className="lp-pin-sticky">
        {beats.map((b, i) => (
          <BeatLayer key={i} beat={b} i={i} n={beats.length} progress={scrollYProgress} store={store} />
        ))}
      </div>
    </section>
  );
}

function BeatLayer({ beat, i, n, progress, store }: { beat: Beat; i: number; n: number; progress: MotionValue<number>; store: StageStore }) {
  const a = BEAT_AT[i];
  const b = BEAT_AT[i + 1];
  // Strictly sequential crossfade: the outgoing caption is gone before the next one arrives — never two at once.
  const f = 0.05;
  const first = i === 0;
  const last = i === n - 1;
  const input = [first ? -1 : a, first ? 0 : a + f, last ? 1 : b - f, last ? 2 : b];
  const opacity = useTransform(progress, input, [first ? 1 : 0, 1, 1, last ? 1 : 0]);
  const y = useTransform(progress, input, [first ? 0 : 36, 0, 0, last ? 0 : -36]);
  const step = useStep(store);
  return (
    <motion.div className="lp-beat" style={{ opacity, y }}>
      <div>
        {first && <p className="lp-beat-eyebrow">Watch it grow · scroll</p>}
        <h2 className="lp-h2">{beat.title}</h2>
      </div>
      <BeatStat beat={beat} step={step} />
    </motion.div>
  );
}

function BeatStat({ beat, step, done = false }: { beat: Beat; step: number; done?: boolean }) {
  const s = beat.stat(step, done);
  return (
    <div className="lp-stat">
      <span className="lp-stat-v">{s.v}</span>
      <span className="lp-stat-k">{s.k}</span>
    </div>
  );
}

/* ---- 3: the statement, revealed word by word as you scroll ---- */

function Statement({ facts, reduced }: { facts: LandingFacts; reduced: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const ending = facts.stop?.reason === "ceiling" ? "Stopped on its own." : "Stopped at its budget.";
  const words = `${facts.nExperiments} experiments. ${facts.nKept} kept. ${ending}`.split(" ");
  return (
    <section ref={ref} className="lp-words" data-stage="dim" data-chapter="overview" style={reduced ? { height: "auto" } : undefined}>
      <div className="lp-words-sticky" style={reduced ? { position: "relative", minHeight: "80svh" } : undefined}>
        <p className="lp-words-text" aria-label={words.join(" ")}>
          {words.map((w, i) => (
            <Word key={i} progress={scrollYProgress} range={[0.08 + (i / words.length) * 0.62, 0.08 + ((i + 1) / words.length) * 0.62]} reduced={reduced} gold={/^\d+$/.test(w)}>
              {w}
            </Word>
          ))}
        </p>
      </div>
    </section>
  );
}

function Word({ children, progress, range, reduced, gold }: { children: string; progress: MotionValue<number>; range: [number, number]; reduced: boolean; gold: boolean }) {
  const opacity = useTransform(progress, range, [0.13, 1]);
  return (
    <>
      <motion.span aria-hidden style={{ opacity: reduced ? 1 : opacity, color: gold ? "var(--lp-gold)" : undefined }}>
        {children}
      </motion.span>{" "}
    </>
  );
}

/* ---- 5: one idea ---- */

function Idea({ title, children, more }: { title: string; children: ReactNode; more: { href: string; label: string } }) {
  const external = more.href.startsWith("http");
  return (
    <div className="lp-idea lp-measure">
      <h2 className="lp-h2">
        <RiseWords text={title} />
      </h2>
      <Reveal delay={0.15}>
        <p>{children}</p>
        {external ? (
          <a className="lp-more" href={more.href}>
            {more.label} <span aria-hidden>→</span>
          </a>
        ) : (
          <Link className="lp-more" href={more.href}>
            {more.label} <span aria-hidden>→</span>
          </Link>
        )}
      </Reveal>
    </div>
  );
}
