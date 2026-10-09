"use client";

/*
 * Landing — Terra Incognita (docs/creative/02-direction.md, direction B).
 * One world, one copy rail, scroll = travel through one real run:
 *   hero → first guess → the climb (three beats) → the mist → the ceiling → the honest test → the map.
 * Rules: exactly one message on screen at every scroll position (./captions messageAt), plain words, every number from
 * the replay files. The land is the COMPLETE run from the first frame (built once at load, never morphed while
 * scrolling). Scroll drives only the bead (rolling along the climb in proportion to scroll), the camera (blended across
 * section boundaries) and three section moments — mist, cloud deck, truth gauge — gated by their sections.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { EvolutionChart } from "@/components/evolution-chart";
import type { AnyEvent } from "@/lib/events";
import { DOCS_URL, GITHUB_URL } from "@/lib/links";
import { formatScore, formatSe, metricInfo } from "@/lib/metrics";
import { buildView, type RunView } from "@/lib/run-state";
import { useWebGLAvailable } from "@/lib/gl";
import { gsap } from "@/lib/motion/gsap";
import type { SurveyPose, SurveyScrub } from "@/lib/survey/contract";
import { MESSAGES, messageAt, type MessageId } from "./captions";
import { beadTFor, cursorFor, type LandingFacts } from "./facts";
import { gatesAt } from "./gates";
import { Hero } from "./hero";
import { EASE, MagneticLink, ScrambleIn, Ticker } from "./primitives";

// three.js stays out of the server render and the first paint; the void + loader show until it streams in.
const SurveyCanvas = dynamic(() => import("@/components/survey/survey-canvas"), { ssr: false, loading: () => null });

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

/** Half-width of the camera blend around each section boundary, as a fraction of the viewport height. */
const BLEND_VH = 0.32;
/** The climb → mist boundary's blend, as a multiple of BLEND_VH (a slow descent from the summit orbit). */
const BLEND_MIST = 1.9;
/**
 * Scroll smoothing rate (1/s): light, so the stage glides between wheel ticks without lagging behind. Only when the
 * page scroll is raw: with Lenis running (html.lenis, see smooth-scroll.tsx) the scroll position is already eased, and
 * easing it a second time made the camera trail the copy — so the stage follows Lenis' value directly.
 */
const SMOOTH = 14;
const lenisSmoothing = () => document.documentElement.classList.contains("lenis");
/** Intro dolly from the orbit shot after the loader (ms). */
const INTRO_MS = 2200;

/* ---- a tiny external store: scroll writes it; React only hears discrete changes ---- */

interface StageState {
  /** The pose that dominates the frame (for pose-keyed effects: depth of field, clouds, truth markers). */
  pose: SurveyPose;
  cursor: number;
  /** Replay moment for this scroll position (the rail's live numbers; the 3D stage always shows the complete run). */
  step: number;
  msg: MessageId;
}

function createStageStore(init: StageState) {
  let s = init;
  const ls = new Set<() => void>();
  return {
    get: () => s,
    set(n: StageState) {
      if (n.pose === s.pose && n.cursor === s.cursor && n.step === s.step && n.msg === s.msg) return;
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

const Stage = memo(function Stage({
  full,
  store,
  narrow,
  scrub,
  onReady,
}: {
  full: RunView;
  store: StageStore;
  narrow: boolean;
  scrub: RefObject<SurveyScrub | null>;
  onReady: () => void;
}) {
  const pose = useSyncExternalStore(
    store.sub,
    () => store.get().pose,
    () => store.get().pose,
  );
  const webgl = useWebGLAvailable();
  if (webgl === false)
    return (
      <div className="lp-fallback-chart" data-theme="dark">
        <EvolutionChart view={full} domainView={full} plannedExperiments={full.experiments.length} compact />
      </div>
    );
  return (
    <SurveyCanvas
      view={full}
      domainView={full}
      pose={pose}
      scrub={scrub}
      quality={narrow ? "lite" : "full"}
      interactive={false}
      className="lp-canvas"
      ariaLabel={`Map of a real ${full.experiments.length}-experiment run: each marker's height is its score.`}
      onReady={onReady}
    />
  );
});

/* ---- section moments ---- */

/* ---- page ---- */

/** Section order and heights (svh). Each is a plain scroll spacer; the stage store reads data-pose. */
const SECTIONS: { pose: SurveyPose; vh: number }[] = [
  { pose: "approach", vh: 100 },
  { pose: "first-probe", vh: 120 },
  { pose: "climb", vh: 520 },
  { pose: "mist", vh: 130 },
  { pose: "ceiling", vh: 130 },
  { pose: "truth", vh: 130 },
  { pose: "chart", vh: 150 },
];

export function Landing({ events, facts }: { events: AnyEvent[]; facts: LandingFacts }) {
  const reduced = useSyncExternalStore(reducedQ.sub, reducedQ.get, () => false);
  const narrow = useSyncExternalStore(narrowQ.sub, narrowQ.get, () => false);
  const webgl = useWebGLAvailable();
  const full = useMemo(() => buildView(events), [events]);
  const [store] = useState(() => createStageStore({ pose: "approach", msg: "hero", ...cursorFor("approach", 0, facts, false) }));
  const scrub = useRef<SurveyScrub | null>({
    a: "approach",
    pa: 0,
    b: "approach",
    pb: 0,
    w: 0,
    intro: 0,
    beadT: beadTFor("approach", 0, facts, false),
    shiftX: 0,
    shiftY: 0,
    gates: { mist: 0, cloud: 0, cloudDrop: 0, truth: 0 },
  });
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const readyAt = useRef<number | null>(null);
  const kick = useRef<() => void>(() => {});

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
  useEffect(() => {
    if (ready && readyAt.current == null) {
      readyAt.current = performance.now();
      kick.current();
    }
  }, [ready]);

  // Scroll → stage. One smoothed scroll value; everything (camera blend, bead, replay cursor, message) is a pure
  // function of it. The rAF loop runs only while the smoothing or the intro is still moving.
  useEffect(() => {
    const els = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-pose]") ?? []);
    let geo: { pose: SurveyPose; start: number; end: number }[] = [];
    let vh = window.innerHeight;
    const measure = () => {
      vh = window.innerHeight;
      const y0 = window.scrollY;
      const maxLine = Math.max(vh * 0.5 + 1, document.documentElement.scrollHeight - vh + vh * 0.5);
      geo = els.map((el) => {
        const r = el.getBoundingClientRect();
        return { pose: el.dataset.pose as SurveyPose, start: r.top + y0, end: r.bottom + y0 };
      });
      if (geo.length) {
        geo[0].start = vh * 0.5; // the reading line at scroll 0
        const last = geo[geo.length - 1];
        last.end = Math.max(last.start + 1, Math.min(last.end, maxLine)); // the furthest the reading line can go
      }
    };
    const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
    const pAt = (k: number, line: number) => clamp01((line - geo[k].start) / Math.max(1, geo[k].end - geo[k].start));

    let smooth = window.scrollY;
    let raf = 0;
    let lastT = 0;
    const apply = (y: number, now: number) => {
      if (!geo.length) return;
      const line = y + vh * 0.5;
      let i = 0;
      for (let k = 0; k < geo.length; k++) if (line >= geo[k].start) i = k;
      const p = pAt(i, line);
      const pose = geo[i].pose;
      // Camera blend across the boundary zone: continuous on both sides of every boundary. The descent from the
      // climb's summit orbit into the mist is the longest move on the page, so it gets a longer, gentler blend.
      const Z = vh * BLEND_VH;
      const zAfter = (k: number) => (geo[k].pose === "climb" && geo[k + 1]?.pose === "mist" ? Z * BLEND_MIST : Z);
      let a = i;
      let b = i;
      let w = 0;
      if (i + 1 < geo.length && line > geo[i].end - zAfter(i)) {
        const zb = zAfter(i);
        b = i + 1;
        w = clamp01((line - (geo[i].end - zb)) / (2 * zb));
      } else if (i > 0 && line < geo[i].start + zAfter(i - 1)) {
        const zb = zAfter(i - 1);
        a = i - 1;
        w = clamp01((line - (geo[i].start - zb)) / (2 * zb));
      }
      if (reduced) w = w < 0.5 ? 0 : 1;
      const intro = reduced ? 1 : readyAt.current == null ? 0 : clamp01((now - readyAt.current) / INTRO_MS);
      const sc = scrub.current!;
      sc.a = geo[a].pose;
      sc.b = geo[b].pose;
      sc.pa = reduced ? 0.5 : pAt(a, line);
      sc.pb = reduced ? 0.5 : pAt(b, line);
      sc.w = w;
      sc.intro = intro;
      sc.beadT = beadTFor(pose, p, facts, reduced);
      sc.shiftX = narrow ? 0 : 0.19;
      sc.shiftY = narrow ? 0.2 : 0;
      gatesAt(geo, line, Z, sc.gates!);
      store.set({ pose: w >= 0.5 ? sc.b : sc.a, msg: messageAt(pose, p), ...cursorFor(pose, p, facts, reduced) });
      return intro;
    };
    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 1 / 60);
      lastT = now;
      const target = window.scrollY;
      smooth = reduced || lenisSmoothing() ? target : smooth + (target - smooth) * (1 - Math.exp(-SMOOTH * dt));
      if (Math.abs(target - smooth) < 0.25) smooth = target;
      const intro = apply(smooth, now) ?? 1;
      if (smooth !== target || (readyAt.current != null && intro < 1)) raf = requestAnimationFrame(frame);
      else lastT = 0;
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    kick.current = start;
    const onResize = () => {
      measure();
      start();
    };
    measure();
    apply(smooth, performance.now());
    start();
    window.addEventListener("scroll", start, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", start);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
      kick.current = () => {};
    };
  }, [facts, reduced, narrow, store]);

  // The site footer rises over the world at the very end: the copy rail lifts away ahead of it, so the two never share
  // the screen. (On phones the landing has no footer: the closing message carries the links.)
  useEffect(() => {
    const foot = document.querySelector<HTMLElement>("body > footer");
    const rail = root.current?.querySelector<HTMLElement>(".lp-rail-inner");
    if (!foot || !rail || getComputedStyle(foot).display === "none") return;
    const tween = gsap.fromTo(
      rail,
      { autoAlpha: 1, y: 0 },
      reduced
        ? { autoAlpha: 0, duration: 0.01, scrollTrigger: { trigger: foot, start: "top 80%", toggleActions: "play none none reverse" } }
        : { autoAlpha: 0, y: -56, ease: "none", scrollTrigger: { trigger: foot, start: "top bottom", end: "top 58%", scrub: 0.4 } },
    );
    return () => {
      tween.scrollTrigger?.kill();
      tween.kill();
      gsap.set(rail, { clearProps: "opacity,visibility,transform" });
    };
  }, [reduced, narrow]);

  return (
    <MotionConfig reducedMotion="user">
      <div ref={root} data-landing className="lp-root" data-theme="dark" data-ready={ready ? "" : undefined} data-webgl={webgl === false ? "off" : "on"}>
        <Loader ready={ready} reduced={reduced} />
        <div className="lp-stage-wrap">
          <Stage full={full} store={store} narrow={narrow} scrub={scrub} onReady={onReady} />
          <div className="lp-scrim" aria-hidden />
        </div>

        <Rail store={store} facts={facts} webgl={webgl !== false} ready={ready} />

        {SECTIONS.map((s) => (
          <section
            key={s.pose}
            className="lp-sec"
            data-pose={s.pose}
            style={{ height: s.pose === "approach" ? "calc(100svh - 57px)" : `${s.vh}svh` }}
            aria-hidden
          />
        ))}
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
      <p className="lp-loader-word">Mapping the run…</p>
      <span className="lp-loader-bar" aria-hidden>
        <span style={{ transform: `scaleX(${n / 100})` }} />
      </span>
      <p className="lp-loader-n">{String(n).padStart(3, "0")}</p>
    </div>
  );
}

/* ---- the copy rail: one message, always ---- */

// A single-slot swap that is never empty: the outgoing message dims (it never fades to nothing), is replaced in the
// same frame by the incoming one at that same dim level, which then brightens. One block on screen, always.
const DIM = 0.32;
const OUT = { opacity: DIM, y: -6, filter: "blur(3px)", transition: { duration: 0.14, ease: [0.4, 0, 1, 1] as const } };
const IN = { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.34, ease: EASE } };
const FROM = { opacity: DIM, y: 10, filter: "blur(5px)" };

/**
 * A single fixed slot. The message id comes from the store (a string, so React re-renders only when it changes —
 * never per scroll frame) and swaps out-then-in, so two messages can never share the screen.
 */
function Rail({ store, facts, webgl, ready }: { store: StageStore; facts: LandingFacts; webgl: boolean; ready: boolean }) {
  const id = useSyncExternalStore(
    store.sub,
    () => store.get().msg,
    () => store.get().msg,
  );
  const idx = MESSAGES.indexOf(id);
  // The hero's staggered entrance plays once, behind the loader; coming back to it later is an ordinary swap.
  const [intro, setIntro] = useState(true);
  if (id !== "hero" && intro) setIntro(false);
  return (
    <div className="lp-rail" data-msg={id} data-intro={intro ? "" : undefined}>
      <div className="lp-rail-inner">
        <ol className="lp-ticks" aria-hidden>
          {MESSAGES.map((m, i) => (
            <li key={m} data-on={i <= idx ? "" : undefined} data-here={i === idx ? "" : undefined} />
          ))}
        </ol>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={id} className="lp-msg" initial={FROM} animate={IN} exit={OUT}>
            <Message id={id} store={store} facts={facts} webgl={webgl} intro={intro} ready={ready} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Stat({ v, k }: { v: ReactNode; k: string }) {
  return (
    <div className="lp-stat">
      <span className="lp-stat-v">{typeof v === "string" ? <ScrambleIn text={v} /> : v}</span>
      <span className="lp-stat-k">{k}</span>
    </div>
  );
}

/** The climb's live numbers: their own subscriber (on the replay step), so the rail itself never re-renders for them. */
function LiveStat({ store, facts, kind }: { store: StageStore; facts: LandingFacts; kind: "tried" | "kept" | "best" }) {
  const step = useSyncExternalStore(
    store.sub,
    () => store.get().step,
    () => store.get().step,
  );
  const at = facts.growth[Math.min(step, facts.growth.length - 1)];
  if (kind === "tried")
    return (
      <Stat
        v={
          <>
            <Ticker value={at.n} format={(x) => String(Math.round(x))} />
            <span className="lp-stat-dim"> of {facts.nExperiments}</span>
          </>
        }
        k="ideas tried so far"
      />
    );
  if (kind === "kept")
    return (
      <Stat
        v={
          <>
            <span className="lp-signal">
              <Ticker value={at.kept} format={(x) => String(Math.round(x))} />
            </span>
            <span className="lp-stat-dim"> kept</span>
          </>
        }
        k={`out of ${at.n} tried`}
      />
    );
  return <Stat v={<Ticker value={at.best} format={(x) => formatScore(facts.metric, x)} />} k="best score so far" />;
}

function Message({
  id,
  store,
  facts,
  webgl,
  intro,
  ready,
}: {
  id: MessageId;
  store: StageStore;
  facts: LandingFacts;
  webgl: boolean;
  intro: boolean;
  ready: boolean;
}) {
  const label = metricInfo(facts.metric).label;
  const replayHref = `/replays/${facts.name}`;
  const sv = facts.survey;
  switch (id) {
    case "hero":
      return <Hero facts={facts} replayHref={replayHref} webgl={webgl} intro={intro} play={ready} />;
    case "first":
      return (
        <>
          <h2 className="lp-h2">It starts with a simple guess.</h2>
          <p className="lp-sub">Every idea lands somewhere on the map. Higher means better.</p>
          {sv.baseline != null && <Stat v={formatScore(facts.metric, sv.baseline)} k="score of the first guess" />}
        </>
      );
    case "climb-0":
      return (
        <>
          <h2 className="lp-h2">Then it tries new ideas.</h2>
          <p className="lp-sub">One at a time, each idea is really tested and dropped onto the map.</p>
          <LiveStat store={store} facts={facts} kind="tried" />
        </>
      );
    case "climb-1":
      return (
        <>
          <h2 className="lp-h2">Only real wins move the ball.</h2>
          <p className="lp-sub">If an improvement could just be luck, it&apos;s thrown away.</p>
          <LiveStat store={store} facts={facts} kind="kept" />
        </>
      );
    case "climb-2":
      return (
        <>
          <h2 className="lp-h2">Up and up.</h2>
          <p className="lp-sub">The ball always rests on the best model so far.</p>
          <LiveStat store={store} facts={facts} kind="best" />
        </>
      );
    case "mist":
      return (
        <>
          <h2 className="lp-h2">Tiny gains don&apos;t count.</h2>
          <p className="lp-sub">Anything smaller than the mist could be chance, so it&apos;s ignored.</p>
          {sv.bestSe != null && <Stat v={`± ${formatSe(sv.bestSe)}`} k="how much scores wobble by chance" />}
        </>
      );
    case "ceiling":
      return (
        <>
          <h2 className="lp-h2">It knows when to stop.</h2>
          <p className="lp-sub">When progress levels off, it stops by itself. No wasted effort.</p>
          <Stat v={String(facts.nExperiments)} k="ideas tried, then it stopped on its own" />
        </>
      );
    case "test":
      return (
        <>
          <h2 className="lp-h2">Then one honest test.</h2>
          <p className="lp-sub">On data it never saw, checked once at the very end.</p>
          {facts.final && <Stat v={formatScore(facts.metric, facts.final.test)} k={`score on unseen data (${label})`} />}
        </>
      );
    case "map":
    default:
      return (
        <>
          <h2 className="lp-h2">
            Your data. Your <em>map.</em>
          </h2>
          <p className="lp-sub">Every run leaves a map like this one.</p>
          <div className="lp-ctas">
            <MagneticLink href="/s/new" requireAuth>
              Try it on your data
            </MagneticLink>
            <MagneticLink href={replayHref} variant="ghost">
              Watch a run
            </MagneticLink>
          </div>
          <nav className="lp-links" aria-label="More">
            <Link href="/replays">All replays</Link>
            <a href={GITHUB_URL}>GitHub</a>
            <a href={DOCS_URL}>Design notes</a>
          </nav>
          <p className="lp-colophon">Every number on this page comes from one real run on a {facts.name.replace(/_/g, " ")} dataset.</p>
        </>
      );
  }
}
