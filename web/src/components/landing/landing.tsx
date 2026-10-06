"use client";

/*
 * Landing — Terra Incognita (docs/creative/02-direction.md, direction B).
 * One world, named camera poses, scroll = travel:
 *   loader (orbit) → approach (headline on the plain) → first probe → the climb (pinned, scrubs the real replay)
 *   → the mist → the ceiling → the truth → the chart.
 * Rules: one idea per screen, one short caption at a time, every number from the replay files, nothing over the
 * canvas but text (no panels, no backdrop blur). The 3D headline has the same words in the DOM for screen readers.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { MotionConfig, motion, useScroll, useTransform, type MotionValue } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { EvolutionChart } from "@/components/evolution-chart";
import type { AnyEvent } from "@/lib/events";
import { DOCS_URL, GITHUB_URL } from "@/lib/links";
import { formatScore, formatSe, metricInfo } from "@/lib/metrics";
import { buildView, type RunView } from "@/lib/run-state";
import { useWebGLAvailable } from "@/lib/gl";
import type { SurveyPose } from "@/lib/survey/contract";
import type { LandingFacts } from "./facts";
import { MagneticLink, Ticker } from "./primitives";

// three.js stays out of the server render and the first paint; the void + loader show until it streams in.
const SurveyCanvas = dynamic(() => import("@/components/survey/survey-canvas"), { ssr: false, loading: () => null });

const HEADLINE = "Models that tinker themselves.";
const OUTRO = "Your data. Your map.";

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

/* ---- a tiny external store: scroll writes it, only the stage reads it ---- */

interface StageState {
  pose: SurveyPose;
  progress: number;
  cursor: number;
  /** Index into facts.growth (for the live numbers in the climb). */
  step: number;
}

function createStageStore(init: StageState) {
  let s = init;
  const ls = new Set<() => void>();
  return {
    get: () => s,
    set(p: Partial<StageState>) {
      const n = { ...s, ...p };
      if (n.pose === s.pose && n.cursor === s.cursor && n.step === s.step && Math.abs(n.progress - s.progress) < 1e-4) return;
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

const Stage = memo(function Stage({ events, full, store, narrow, onReady }: { events: AnyEvent[]; full: RunView; store: StageStore; narrow: boolean; onReady: () => void }) {
  const s = useSyncExternalStore(store.sub, store.get, store.get);
  const webgl = useWebGLAvailable();
  const view = useMemo(() => (s.cursor >= events.length ? full : buildView(events.slice(0, s.cursor))), [events, full, s.cursor]);
  const headline = s.pose === "approach" || s.pose === "orbit" ? HEADLINE : s.pose === "chart" ? OUTRO : null;
  if (webgl === false)
    return (
      <div className="lp-fallback-chart" data-theme="dark">
        <EvolutionChart view={full} domainView={full} plannedExperiments={full.experiments.length} compact />
      </div>
    );
  return (
    <SurveyCanvas
      view={view}
      domainView={full}
      pose={s.pose}
      poseProgress={s.progress}
      quality={narrow ? "lite" : "full"}
      interactive={false}
      headline={headline}
      className="lp-canvas"
      ariaLabel={`Survey of the ${full.experiments.length}-experiment replay: each probe's height is its cross-validated score.`}
      onReady={onReady}
    />
  );
});

/* ---- page ---- */

/** Section → which moment of the replay it shows. */
function cursorFor(pose: SurveyPose, p: number, facts: LandingFacts, reduced: boolean): { cursor: number; step: number } {
  const g = facts.growth;
  const last = g.length - 1; // the stop
  const preStop = Math.max(0, last - 1);
  switch (pose) {
    case "first-probe":
      return { cursor: g[Math.min(1, last)].cursor, step: Math.min(1, last) };
    case "climb": {
      if (reduced) return { cursor: g[preStop].cursor, step: preStop };
      const t = Math.min(1, Math.max(0, (p - 0.02) / 0.9));
      const i = Math.min(preStop, Math.max(1, 1 + Math.round(t * (preStop - 1))));
      return { cursor: g[i].cursor, step: i };
    }
    case "ceiling":
      return { cursor: g[last].cursor, step: last };
    case "truth":
    case "chart":
      return { cursor: facts.end, step: last };
    default:
      return { cursor: g[preStop].cursor, step: preStop };
  }
}

export function Landing({ events, facts }: { events: AnyEvent[]; facts: LandingFacts }) {
  const reduced = useSyncExternalStore(reducedQ.sub, reducedQ.get, () => false);
  const narrow = useSyncExternalStore(narrowQ.sub, narrowQ.get, () => false);
  const webgl = useWebGLAvailable();
  const full = useMemo(() => buildView(events), [events]);
  const [store] = useState(() => createStageStore({ pose: "orbit", progress: 0, ...cursorFor("approach", 0, facts, false) }));
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const readyRef = useRef(false);

  // Loader gate: never block for long — if WebGL is missing or slow, open anyway.
  useEffect(() => {
    if (webgl === false) {
      const t = setTimeout(() => setReady(true), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setReady(true), 7000);
    return () => clearTimeout(t);
  }, [webgl]);
  const [onReady] = useState(() => () => setReady(true));

  // Scroll → (pose, progress, cursor). One passive listener, one rAF; the page itself never re-renders.
  useEffect(() => {
    readyRef.current = ready;
    const sections = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-pose]") ?? []);
    let raf = 0;
    const apply = () => {
      raf = 0;
      const vh = window.innerHeight;
      let pose: SurveyPose = "approach";
      let p = 0;
      for (const el of sections) {
        const r = el.getBoundingClientRect();
        if (r.top <= vh * 0.5 && r.bottom > vh * 0.5) {
          pose = el.dataset.pose as SurveyPose;
          p = el.dataset.pin != null ? -r.top / Math.max(1, r.height - vh) : (vh * 0.5 - r.top) / Math.max(1, r.height);
          break;
        }
        if (r.top > vh * 0.5) break;
        pose = el.dataset.pose as SurveyPose;
        p = 1;
      }
      p = Math.min(1, Math.max(0, p));
      if (!readyRef.current && pose === "approach") pose = "orbit";
      const c = cursorFor(pose, p, facts, reduced);
      store.set({ pose, progress: reduced ? 0.5 : p, ...c });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [facts, reduced, store, ready]);

  // As the hero scrolls away its copy lifts and fades, so it never sits on the headline lying on the plain.
  const hero = useRef<HTMLElement>(null);
  const { scrollYProgress: heroP } = useScroll({ target: hero, offset: ["start start", "end start"] });
  const heroFade = useTransform(heroP, [0, 0.3], [1, 0]);
  const heroLift = useTransform(heroP, [0, 0.3], [0, -40]);

  const replayHref = `/replays/${facts.name}`;
  const proposerLine = facts.proposer === "heuristic" ? "offline heuristic proposer (no LLM)" : `proposer: ${facts.proposer}`;
  const label = metricInfo(facts.metric).label;
  const sv = facts.survey;

  return (
    <MotionConfig reducedMotion="user">
      <div ref={root} data-landing className="lp-root" data-theme="dark" data-ready={ready ? "" : undefined} data-webgl={webgl === false ? "off" : "on"}>
        <Loader ready={ready} reduced={reduced} />
        <div className="lp-stage-wrap" aria-hidden={false}>
          <Stage events={events} full={full} store={store} narrow={narrow} onReady={onReady} />
          <div className="lp-scrim" aria-hidden />
        </div>

        {/* 1 — APPROACH: the headline lies on the plain (SDF in the scene; the same words here for everyone else). */}
        <section ref={hero} className="lp-sec lp-hero" data-pose="approach">
          <h1 className={webgl === false ? "lp-h1" : "sr-only"}>{HEADLINE}</h1>
          <motion.div className="lp-hero-copy" style={{ opacity: heroFade, y: heroLift }}>
            <p className="lp-sub lp-in" style={{ "--d": "200ms" } as CSSProperties}>
              AutoTinker evolves a readable ML pipeline, keeps only what beats the noise, and knows when to stop.
            </p>
            <div className="lp-ctas lp-in" style={{ "--d": "320ms" } as CSSProperties}>
              <MagneticLink href={replayHref}>Watch a run</MagneticLink>
              <MagneticLink href="/new" variant="ghost">
                Start a survey
              </MagneticLink>
            </div>
          </motion.div>
          <div className="lp-hero-foot lp-in" style={{ "--d": "520ms" } as CSSProperties}>
            <p className="lp-honest">
              <span className="lp-honest-dot" aria-hidden />
              Replay of a real run · {proposerLine}
            </p>
            {webgl !== false && (
              <p className="lp-hint" aria-hidden>
                <span className="lp-hint-ring" /> Press and hold to sound the land
              </p>
            )}
          </div>
        </section>

        {/* 2 — FIRST PROBE */}
        <Chapter pose="first-probe" n="01" eyebrow="First probe" title="Every experiment is a probe." height={150}>
          <p className="lp-sub">Where it lands, ground appears. Its height is the real score.</p>
          {sv.baseline != null && <Stat v={formatScore(facts.metric, sv.baseline)} k={`baseline · cross-validated ${label}`} />}
        </Chapter>

        {/* 3 — THE CLIMB: pinned; scroll scrubs the real replay. */}
        <Climb facts={facts} store={store} reduced={reduced} />

        {/* 4 — THE MIST */}
        <Chapter pose="mist" n="03" eyebrow="The mist" title="Gains smaller than the mist are noise." height={160}>
          <p className="lp-sub">The mist is as thick as the best score&apos;s standard error. A probe inside it is a tie, so it is not kept.</p>
          {sv.bestSe != null && <Stat v={`± ${formatSe(sv.bestSe)}`} k="standard error of the best" />}
        </Chapter>

        {/* 5 — THE CEILING */}
        <Chapter pose="ceiling" n="04" eyebrow="The ceiling" title="It stops when the rest is in the clouds." height={170}>
          <p className="lp-sub">The stop rule fits the climb and settles a cloud deck at the asymptote, just above the summit.</p>
          {sv.ceiling != null ? (
            <Stat
              v={formatScore(facts.metric, sv.ceiling)}
              k={facts.stop && facts.stop.signals > 0 ? `fitted ceiling · ${facts.stop.fired} of ${facts.stop.signals} stop signals agreed` : "fitted ceiling"}
            />
          ) : (
            facts.stop && <Stat v={`${facts.stop.fired} / ${facts.stop.signals}`} k="stop signals agreed" />
          )}
        </Chapter>

        {/* 6 — THE TRUTH */}
        <Chapter pose="truth" n="05" eyebrow="The locked test" title="One locked test, opened once." height={170}>
          <p className="lp-sub">A split it never saw, scored a single time at the very end.</p>
          {facts.final && (
            <Stat
              v={formatScore(facts.metric, facts.final.test)}
              k={`${label} on the locked test · select ${formatScore(facts.metric, facts.final.select)} · ${facts.final.gapText}`}
            />
          )}
        </Chapter>

        {/* 7 — THE CHART */}
        <section className="lp-sec lp-chart" data-pose="chart" style={{ minHeight: "150svh" }}>
          <div className="lp-chart-inner">
            <h2 className="sr-only">{OUTRO}</h2>
            <p className="lp-eyebrow">
              <span>06</span> The map
            </p>
            <p className="lp-sub lp-measure">
              {facts.nExperiments} probes, {facts.nKept} kept, stopped on its own. Every run leaves a map like this one.
            </p>
            <div className="lp-ctas">
              <MagneticLink href="/new">Start a survey</MagneticLink>
              <MagneticLink href={replayHref} variant="ghost">
                Watch a run
              </MagneticLink>
            </div>
            <nav className="lp-links" aria-label="More">
              <Link href="/replays">All replays</Link>
              <a href={GITHUB_URL}>GitHub</a>
              <a href={DOCS_URL}>Design notes</a>
            </nav>
            <p className="lp-colophon">
              Height is measured: each probe sits at its cross-validated {label}. The map is a projection: bearing is the idea&apos;s family, step is
              the size of the change. Every number here comes from the {facts.name.replace(/_/g, " ")} replay.
            </p>
          </div>
        </section>
      </div>
    </MotionConfig>
  );
}

/* ---- loader: the first frame behind it IS the intro shot ---- */

function Loader({ ready, reduced }: { ready: boolean; reduced: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (ready) {
      const t = setTimeout(() => setN(100), 0);
      return () => clearTimeout(t);
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      // Eases toward 92 while shaders compile; the last stretch is the real "ready".
      const k = 1 - Math.exp(-(performance.now() - t0) / 1400);
      setN(Math.round(92 * k));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready]);
  return (
    <div className="lp-loader" data-done={ready ? "" : undefined} data-reduced={reduced ? "" : undefined} aria-hidden={ready} role="status">
      <p className="lp-loader-word">Surveying…</p>
      <p className="lp-loader-n">{String(n).padStart(3, "0")}</p>
    </div>
  );
}

/* ---- one chapter: a sticky caption that fades in and out with its section ---- */

function Chapter({ pose, n, eyebrow, title, height, children }: { pose: SurveyPose; n: string; eyebrow: string; title: string; height: number; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const opacity = useTransform(scrollYProgress, [0.22, 0.36, 0.7, 0.82], [0, 1, 1, 0]);
  const y = useTransform(scrollYProgress, [0.22, 0.36, 0.7, 0.82], [28, 0, 0, -20]);
  return (
    <section ref={ref} className="lp-sec lp-chapter" data-pose={pose} style={{ height: `${height}svh` }}>
      <div className="lp-sticky">
        <motion.div className="lp-caption" style={{ opacity, y }}>
          <p className="lp-eyebrow">
            <span>{n}</span> {eyebrow}
          </p>
          <h2 className="lp-h2">{title}</h2>
          {children}
        </motion.div>
      </div>
    </section>
  );
}

function Stat({ v, k }: { v: ReactNode; k: string }) {
  return (
    <div className="lp-stat">
      <span className="lp-stat-v">{v}</span>
      <span className="lp-stat-k">{k}</span>
    </div>
  );
}

/* ---- the pinned climb ---- */

const BEAT_AT = [0, 0.34, 0.67, 1];

function Climb({ facts, store, reduced }: { facts: LandingFacts; store: StageStore; reduced: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const step = useSyncExternalStore(store.sub, () => store.get().step, () => 0);
  const g = facts.growth;
  const at = g[Math.min(step, g.length - 1)];
  const label = metricInfo(facts.metric).label;
  const beats: { title: string; sub: string; stat: ReactNode; k: string }[] = [
    {
      title: "Each idea sends a probe.",
      sub: "Bearing is the idea's family; the step is the size of the change.",
      stat: (
        <>
          <Ticker value={at.n} format={(x) => String(Math.round(x)).padStart(2, "0")} />
          <span className="lp-stat-dim"> / {facts.nExperiments}</span>
        </>
      ),
      k: "experiments, one hypothesis each",
    },
    {
      title: "The bead moves only on a real gain.",
      sub: "A corrected paired test decides. Everything else stays a stake on lower ground.",
      stat: (
        <>
          <span className="lp-signal">
            <Ticker value={at.kept} format={(x) => String(Math.round(x))} />
          </span>
          <span className="lp-stat-dim"> kept</span>
        </>
      ),
      k: `of ${at.n} tried`,
    },
    {
      title: "Up is better.",
      sub: "The mercury rests on the best score so far.",
      stat: <Ticker value={at.best} format={(x) => formatScore(facts.metric, x)} />,
      k: `best cross-validated ${label} so far`,
    },
  ];
  if (reduced)
    return (
      <section className="lp-sec lp-chapter" data-pose="climb" style={{ height: "auto" }} aria-label="The climb">
        {beats.map((b, i) => (
          <div key={i} className="lp-sticky lp-static">
            <div className="lp-caption">
              <p className="lp-eyebrow">
                <span>02</span> The climb
              </p>
              <h2 className="lp-h2">{b.title}</h2>
              <p className="lp-sub">{b.sub}</p>
              <Stat v={b.stat} k={b.k} />
            </div>
          </div>
        ))}
      </section>
    );
  return (
    <section ref={ref} className="lp-sec lp-pin" data-pose="climb" data-pin="" aria-label="The climb">
      <div className="lp-sticky">
        {beats.map((b, i) => (
          <BeatLayer key={i} i={i} n={beats.length} progress={scrollYProgress}>
            {i === 0 && (
              <p className="lp-eyebrow">
                <span>02</span> The climb · scroll
              </p>
            )}
            <h2 className="lp-h2">{b.title}</h2>
            <p className="lp-sub">{b.sub}</p>
            <Stat v={b.stat} k={b.k} />
          </BeatLayer>
        ))}
      </div>
    </section>
  );
}

function BeatLayer({ i, n, progress, children }: { i: number; n: number; progress: MotionValue<number>; children: ReactNode }) {
  const a = BEAT_AT[i];
  const b = BEAT_AT[i + 1];
  const f = 0.045;
  const first = i === 0;
  const last = i === n - 1;
  // Strictly sequential: the outgoing caption is gone before the next arrives — never two at once.
  const input = [first ? 0 : a, first ? 0.001 : a + f, last ? 0.999 : b - f, last ? 1 : b];
  const opacity = useTransform(progress, input, [first ? 1 : 0, 1, 1, last ? 1 : 0]);
  const y = useTransform(progress, input, [first ? 0 : 24, 0, 0, last ? 0 : -24]);
  return (
    <motion.div className="lp-caption lp-beat" style={{ opacity, y }}>
      {children}
    </motion.div>
  );
}
