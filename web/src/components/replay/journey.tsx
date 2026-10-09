"use client";

/*
 * A recorded run as a scroll journey, at the landing's level (docs/creative/02-direction.md: one world, travel as
 * navigation, one message). Same model as the landing, for any replay:
 *   - one full-bleed world, fixed behind the page: the COMPLETE run from the first frame, never rebuilt while scrolling;
 *   - one fixed copy rail showing exactly one message at every scroll position (./journey-facts messageAt);
 *   - scroll moves only the ball (along the climb, at a calm pace), the camera (blended across every section boundary)
 *     and the section moments (mist, cloud deck, truth gauge — gated by their own sections).
 * Beats: summary → the climb, idea by idea → why it stopped (mist, then the cloud deck) → the final test → the map →
 * the full record (the world stays behind it, dimmed, seen from above).
 * Smoothing: when Lenis is driving the page (components/smooth-scroll) scrollY is already eased, so the journey follows
 * it directly instead of easing it a second time; without Lenis it eases scrollY on its own.
 */

import { useLenis } from "lenis/react";
import Link from "next/link";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { EvolutionChart } from "@/components/evolution-chart";
import { gatesAt, ramp } from "@/components/landing/gates";
import { EASE, MagneticLink } from "@/components/landing/primitives";
import { SurveyCanvas } from "@/components/survey-source";
import { useWebGLAvailable } from "@/lib/gl";
import { formatSe, metricInfo } from "@/lib/metrics";
import type { RunView } from "@/lib/run-state";
import { displayScore, humanName, outcomeOf, plainGap, plainIdea, plainStopSignals, plainVerdict, stopPhrase } from "@/lib/story";
import type { SurveyPose, SurveyScrub } from "@/lib/survey/contract";
import {
  beadTAt,
  beatsOf,
  climbAt,
  journeyOf,
  keptThrough,
  messageAt,
  poseProgress,
  progressForIdea,
  type BeatKind,
  type Journey as JourneyFacts,
  type JourneyMsg,
} from "./journey-facts";
import { RevealHeading, ScrambleNumber, scrollDocTo } from "./motion";
import { Summary } from "./stage";

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

/** The landing's scroll constants: blend half-width (× viewport height), the long descent into the mist, smoothing. */
const BLEND_VH = 0.32;
const BLEND_MIST = 1.9;
const SMOOTH = 14;
const INTRO_MS = 1800;
/** How far the world dims behind the full record. */
const RECORD_DIM = 0.78;
/** The record's message starts when its top is this far (× viewport height) below the reading line. */
const RECORD_LEAD = 0.4;

/* ---- a tiny external store: scroll writes it; React only hears discrete changes ---- */

interface StageState {
  pose: SurveyPose;
  msg: JourneyMsg;
  /** Idea on the card (climb only), else null. */
  idea: number | null;
}
function createStore(init: StageState) {
  let s = init;
  const ls = new Set<() => void>();
  return {
    get: () => s,
    set(n: StageState) {
      if (n.pose === s.pose && n.msg === s.msg && n.idea === s.idea) return;
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
type Store = ReturnType<typeof createStore>;

interface Geo {
  kind: BeatKind;
  pose: SurveyPose;
  start: number;
  end: number;
}

interface Props {
  /** The complete run (prebuilt land). */
  view: RunView;
  name: string;
  kicker?: string;
  note?: ReactNode;
  /** "Watch it run" (simulate). */
  action?: ReactNode;
  /** Other recorded runs, for the closing message. */
  others?: { name: string }[];
  /** Open an idea in the full record. */
  onDetails: (id: string) => void;
  /** The full record. */
  children: ReactNode;
}

export function Journey({ view, name, kicker, note, action, others = [], onDetails, children }: Props) {
  const reduced = useSyncExternalStore(reducedQ.sub, reducedQ.get, () => false);
  const narrow = useSyncExternalStore(narrowQ.sub, narrowQ.get, () => false);
  const webgl = useWebGLAvailable();
  const J = useMemo(() => journeyOf(view), [view]);
  const beats = useMemo(() => beatsOf(J, { stop: !!view.stop, final: !!view.final }), [J, view.stop, view.final]);
  const [store] = useState(() => createStore({ pose: "approach", msg: "summary", idea: null }));
  const scrub = useRef<SurveyScrub | null>({
    a: "approach",
    pa: 0,
    b: "approach",
    pb: 0,
    w: 0,
    intro: reduced ? 1 : 0,
    beadT: 0,
    shiftX: 0,
    shiftY: 0,
    gates: { mist: 0, cloud: 0, cloudDrop: 0, truth: 0 },
    aimId: null,
    aimW: 0,
  });
  const root = useRef<HTMLDivElement>(null);
  const stageEl = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const readyAt = useRef<number | null>(null);
  const kick = useRef<() => void>(() => {});
  const goIdea = useRef<(i: number) => void>(() => {});
  const goBeat = useRef<(k: BeatKind) => void>(() => {});
  const lenis = useLenis();
  const lenisRef = useRef(lenis);
  useEffect(() => {
    lenisRef.current = lenis;
  }, [lenis]);

  // Never block on the world: if WebGL is missing or slow, show the page anyway.
  useEffect(() => {
    const t = setTimeout(() => setReady(true), webgl === false ? 0 : 6000);
    return () => clearTimeout(t);
  }, [webgl]);
  const [onReady] = useState(() => () => setReady(true));
  useEffect(() => {
    if (ready && readyAt.current == null) {
      readyAt.current = performance.now();
      kick.current();
    }
  }, [ready]);

  // Scroll → stage: one smoothed scroll value; camera blend, ball, aim, gates and the message are pure functions of it.
  useEffect(() => {
    const els = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-beat]") ?? []);
    let geo: Geo[] = [];
    let vh = window.innerHeight;
    const measure = () => {
      vh = window.innerHeight;
      const y0 = window.scrollY;
      const maxLine = Math.max(vh * 0.5 + 1, document.documentElement.scrollHeight - vh + vh * 0.5);
      geo = els.map((el) => {
        const r = el.getBoundingClientRect();
        const kind = el.dataset.beat as BeatKind;
        // the record takes over the rail as soon as it peeks in from below, so it never slides under the map's copy
        const lead = kind === "record" ? vh * (narrow ? 0.7 : RECORD_LEAD) : 0;
        return { kind, pose: el.dataset.pose as SurveyPose, start: r.top + y0 - lead, end: r.bottom + y0 };
      });
      if (geo.length) {
        geo[0].start = Math.min(geo[0].start, vh * 0.5);
        const last = geo[geo.length - 1];
        last.end = Math.max(last.start + 1, Math.min(last.end, maxLine));
      }
    };
    const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
    const pAt = (k: number, line: number) => clamp01((line - geo[k].start) / Math.max(1, geo[k].end - geo[k].start));
    const exps = view.experiments;

    let smooth = window.scrollY;
    let raf = 0;
    let lastT = 0;
    let lastDim = -1;
    const apply = (y: number, now: number) => {
      if (!geo.length) return 1;
      const line = y + vh * 0.5;
      let i = 0;
      for (let k = 0; k < geo.length; k++) if (line >= geo[k].start) i = k;
      const p = pAt(i, line);
      const g = geo[i];
      const Z = vh * BLEND_VH;
      const zAfter = (k: number) => (geo[k].pose === "climb" && geo[k + 1]?.pose === "mist" ? Z * BLEND_MIST : Z);
      let a = i;
      let b = i;
      let w = 0;
      if (i + 1 < geo.length && line > g.end - zAfter(i)) {
        const zb = zAfter(i);
        b = i + 1;
        w = clamp01((line - (g.end - zb)) / (2 * zb));
      } else if (i > 0 && line < g.start + zAfter(i - 1)) {
        const zb = zAfter(i - 1);
        a = i - 1;
        w = clamp01((line - (g.start - zb)) / (2 * zb));
      }
      if (reduced) w = w < 0.5 ? 0 : 1;
      const intro = reduced ? 1 : readyAt.current == null ? 0 : clamp01((now - readyAt.current) / INTRO_MS);
      const sc = scrub.current!;
      sc.a = geo[a].pose;
      sc.b = geo[b].pose;
      sc.pa = reduced ? 0.5 : poseProgress(J, geo[a].kind, pAt(a, line));
      sc.pb = reduced ? 0.5 : poseProgress(J, geo[b].kind, pAt(b, line));
      sc.w = w;
      sc.intro = intro;
      sc.beadT = beadTAt(J, g.kind, p, reduced);
      sc.shiftX = narrow ? 0 : 0.19;
      sc.shiftY = narrow ? 0.2 : 0;
      gatesAt(geo, line, Z, sc.gates!);
      // the tail of the climb: lean toward each dropped idea's marker in turn
      let idea: number | null = null;
      if (g.kind === "climb" && J.n > 0) {
        const c = climbAt(J, p, reduced);
        idea = c.idea;
        sc.aimId = c.aimW > 0 ? (exps[c.idea]?.id ?? null) : null;
        sc.aimW = reduced ? 0 : c.aimW * (1 - w);
      } else {
        sc.aimId = null;
        sc.aimW = 0;
      }
      // behind the full record the world stays, dimmed and seen from above
      const rec = geo[geo.length - 1];
      const dim = rec.kind === "record" ? ramp(rec.start - vh * 0.05, rec.start + vh * 0.45, line) : 0;
      if (stageEl.current && Math.abs(dim - lastDim) > 0.002) {
        stageEl.current.style.opacity = String(1 - RECORD_DIM * dim);
        lastDim = dim;
      }
      store.set({ pose: w >= 0.5 ? sc.b : sc.a, msg: messageAt(J, g.kind, p), idea });
      return intro;
    };
    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 1 / 60);
      lastT = now;
      const target = window.scrollY;
      // Lenis already eases wheel and programmatic scrolls; easing them again here would make the world trail the page
      // twice over. Native scrolling (touch, scrollbar drag; Lenis reports "native") keeps the journey's own easing.
      const eased = !!lenisRef.current && lenisRef.current.isScrolling !== "native";
      smooth = reduced || eased ? target : smooth + (target - smooth) * (1 - Math.exp(-SMOOTH * dt));
      if (Math.abs(target - smooth) < 0.25) smooth = target;
      const intro = apply(smooth, now);
      if (smooth !== target || (readyAt.current != null && intro < 1)) raf = requestAnimationFrame(frame);
      else lastT = 0;
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    kick.current = start;
    const scrollToLine = (line: number) => scrollDocTo(Math.max(0, line - vh * 0.5), lenisRef.current);
    goIdea.current = (k: number) => {
      const c = geo.find((x) => x.kind === "climb");
      if (!c || J.n === 0) return;
      const p = progressForIdea(J, k);
      scrollToLine(c.start + p * (c.end - c.start));
    };
    goBeat.current = (kind: BeatKind) => {
      const c = geo.find((x) => x.kind === kind);
      if (!c) return;
      if (kind === "summary") scrollDocTo(0, lenisRef.current);
      else if (kind === "record") scrollDocTo(Math.max(0, c.start - 24), lenisRef.current);
      else scrollToLine((c.start + Math.min(c.end, c.start + vh)) / 2);
    };
    const onResize = () => {
      measure();
      start();
    };
    // the record's rows open and close: its height changes, so re-measure
    const ro = new ResizeObserver(onResize);
    if (root.current) ro.observe(root.current);
    measure();
    apply(smooth, performance.now());
    start();
    window.addEventListener("scroll", start, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", start);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
      kick.current = () => {};
    };
  }, [J, view.experiments, reduced, narrow, store, beats]);

  // ←/→ step through the ideas (from the summary, → starts the climb).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input,textarea,select,[contenteditable],[role=tablist]")) return;
      const s = store.get();
      const fwd = e.key === "ArrowRight";
      if (s.idea != null) {
        e.preventDefault();
        if (!fwd && s.idea === 0) goBeat.current("summary");
        else if (fwd && s.idea === J.n - 1) goBeat.current(beats[2]?.kind ?? "map");
        else goIdea.current(s.idea + (fwd ? 1 : -1));
      } else if (s.msg === "summary" && fwd) {
        e.preventDefault();
        goIdea.current(0);
      } else if (s.msg === beats[2]?.kind && !fwd) {
        e.preventDefault();
        goIdea.current(J.n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, J, beats]);

  return (
    <MotionConfig reducedMotion="user">
      <div ref={root} data-journey className="jn-root" data-ready={ready ? "" : undefined} data-webgl={webgl === false ? "off" : "on"}>
        <div ref={stageEl} className="jn-stage">
          <World view={view} store={store} narrow={narrow} scrub={scrub} onReady={onReady} />
          <div className="jn-scrim" aria-hidden />
        </div>

        <Rail
          store={store}
          view={view}
          J={J}
          beats={beats}
          name={name}
          kicker={kicker}
          note={note}
          action={action}
          others={others}
          onDetails={onDetails}
          goIdea={goIdea}
          goBeat={goBeat}
        />

        {beats
          .filter((b) => b.kind !== "record")
          .map((b) => (
            <section
              key={b.kind}
              className="jn-sec"
              data-beat={b.kind}
              data-pose={b.pose}
              style={{ height: b.kind === "summary" ? "calc(100svh - 57px)" : `${b.vh}svh` }}
              aria-hidden
            />
          ))}
        <div className="jn-record" data-beat="record" data-pose="chart">
          {children}
        </div>
      </div>
    </MotionConfig>
  );
}

/* ---- the world ---- */

const World = memo(function World({
  view,
  store,
  narrow,
  scrub,
  onReady,
}: {
  view: RunView;
  store: Store;
  narrow: boolean;
  scrub: RefObject<SurveyScrub | null>;
  onReady: () => void;
}) {
  const pose = useSyncExternalStore(
    store.sub,
    () => store.get().pose,
    () => store.get().pose,
  );
  const idea = useSyncExternalStore(
    store.sub,
    () => store.get().idea,
    () => store.get().idea,
  );
  const webgl = useWebGLAvailable();
  const selectedId = idea != null ? (view.experiments[idea]?.id ?? null) : null;
  if (webgl === false)
    return (
      <div className="jn-fallback">
        <EvolutionChart view={view} domainView={view} plannedExperiments={view.experiments.length} selectedId={selectedId} compact />
      </div>
    );
  return (
    <SurveyCanvas
      view={view}
      domainView={view}
      pose={pose}
      scrub={scrub}
      selectedId={selectedId}
      quality={narrow ? "lite" : "full"}
      interactive={false}
      className="absolute inset-0"
      ariaLabel={`Map of the run: ${view.experiments.length} ideas, each marker's height is its score. The amber trail is the path of ideas it kept.`}
      onReady={onReady}
    />
  );
});

/* ---- the copy rail: one message, always ---- */

const DIM = 0.32;
const OUT = { opacity: DIM, y: -6, transition: { duration: 0.13, ease: [0.4, 0, 1, 1] as const } };
const IN = { opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE } };
const FROM = { opacity: DIM, y: 8 };

interface RailProps {
  store: Store;
  view: RunView;
  J: JourneyFacts;
  beats: ReturnType<typeof beatsOf>;
  name: string;
  kicker?: string;
  note?: ReactNode;
  action?: ReactNode;
  others: { name: string }[];
  onDetails: (id: string) => void;
  goIdea: RefObject<(i: number) => void>;
  goBeat: RefObject<(k: BeatKind) => void>;
}

function Rail(props: RailProps) {
  const { store, beats } = props;
  const id = useSyncExternalStore(
    store.sub,
    () => store.get().msg,
    () => store.get().msg,
  );
  // The rail's layout (centred copy vs the record's corner pill) follows the message on screen, not the one queued:
  // the outgoing message finishes its exit where it was.
  const [laid, setLaid] = useState<JourneyMsg>(id);
  const latest = useRef(id);
  useEffect(() => {
    latest.current = id.startsWith("idea-") ? "idea-0" : id;
  }, [id]);
  // One panel for every carded idea (its changing parts crossfade inside it), one for the tail, one per other beat:
  // the panel itself only swaps at a beat boundary.
  const panel: JourneyMsg = id.startsWith("idea-") ? "idea-0" : id;
  const climbing = panel === "idea-0" || panel === "tail";
  const shown = beats.filter((b) => b.kind !== "record");
  const kindOf: BeatKind = climbing ? "climb" : (id as BeatKind);
  const here = shown.findIndex((b) => b.kind === kindOf);
  return (
    <div className="jn-rail" data-msg={laid} data-climb={laid === "idea-0" || laid === "tail" ? "" : undefined}>
      <div className="jn-rail-inner">
        {id !== "record" && (
          <ol className="lp-ticks jn-ticks" aria-hidden>
            {shown.map((b, i) => (
              <li key={b.kind} data-on={i <= here ? "" : undefined} data-here={i === here ? "" : undefined} />
            ))}
          </ol>
        )}
        <AnimatePresence mode="wait" initial={false} onExitComplete={() => setLaid(latest.current)}>
          <motion.div key={panel} className="jn-msg" initial={FROM} animate={IN} exit={OUT}>
            <Message id={panel} {...props} />
          </motion.div>
        </AnimatePresence>
      </div>
      <IdeaStrip {...props} on={climbing} />
    </div>
  );
}

function Message({ id, store, view, J, name, kicker, note, action, others, onDetails, goBeat }: RailProps & { id: JourneyMsg }) {
  const metric = view.metric;
  const label = metricInfo(metric).label;
  const best = view.experiments.find((x) => x.id === view.bestId);
  const f = view.final;
  if (id.startsWith("idea-")) return <IdeaCard store={store} view={view} J={J} onDetails={onDetails} />;
  if (id === "tail") return <TailCard store={store} view={view} J={J} onDetails={onDetails} />;
  switch (id) {
    case "summary":
      return (
        <Summary
          view={view}
          name={name}
          kicker={kicker}
          note={note}
          action={action}
          secondary={
            <MagneticLink href="/s/new" variant="ghost">
              Try your own data
            </MagneticLink>
          }
          hint={
            <p className="lp-hint jn-hint">
              <span className="lp-hint-line" aria-hidden />
              <span>Scroll to follow the climb, idea by idea</span>
            </p>
          }
        />
      );
    case "noise":
      return (
        <>
          <RevealHeading className="lp-h2">Then the gains got too small to trust.</RevealHeading>
          <p className="lp-sub">Scores wobble a little by chance. A gain smaller than that wobble, the mist on the map, doesn&apos;t count.</p>
          {best?.cv?.se != null && (
            <div className="lp-stat">
              <ScrambleNumber className="lp-stat-v" value={`± ${formatSe(best.cv.se, metricInfo(metric).digits)}`} delay={0.25} />
              <span className="lp-stat-k">how much the best score wobbles by chance</span>
            </div>
          )}
        </>
      );
    case "stop": {
      const signals = plainStopSignals(view);
      const ceiling = view.stop?.reason === "ceiling";
      const o = outcomeOf(view);
      return (
        <>
          <RevealHeading className="lp-h2">{ceiling ? "So it stopped on its own." : `It ${stopPhrase(view.stop?.reason) ?? "stopped"}.`}</RevealHeading>
          <p className="lp-sub">{ceiling ? `After ${o.tried} ideas, every sign said progress had levelled off.` : `After ${o.tried} ideas.`}</p>
          {signals.length > 0 && (
            <ul className="jn-signals">
              {signals.map((s) => (
                <li key={s.key} data-fired={s.fired ? "" : undefined}>
                  <span className="jn-signal-mark" aria-label={s.fired ? "agreed" : "did not agree"} />
                  {s.text}
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case "test":
      return (
        <>
          <RevealHeading className="lp-h2">Then one honest test.</RevealHeading>
          <p className="lp-sub">Its best model, on data it had never seen, opened once at the very end.</p>
          {f && (
            <div className="lp-stat">
              <ScrambleNumber className="lp-stat-v" value={displayScore(metric, f.testScore)} delay={0.25} duration={1.2} />
              <span className="lp-stat-k">{label} on data it never saw</span>
            </div>
          )}
          {f && <p className="jn-gap">{plainGap(metric, f.optimismGap, best?.cv?.se)}</p>}
        </>
      );
    case "map": {
      const o = outcomeOf(view);
      const first = view.experiments[0]?.cv?.mean;
      return (
        <>
          <RevealHeading className="lp-h2">
            The whole <em>map.</em>
          </RevealHeading>
          <p className="lp-sub">
            {o.tried} ideas, <span className="lp-signal">{o.kept} kept</span>
            {first != null && best?.cv ? (
              <>
                , from {displayScore(metric, first)} to {displayScore(metric, best.cv.mean)} {label}.
              </>
            ) : (
              "."
            )}{" "}
            Every marker is one idea; the amber trail is the path it kept.
          </p>
          <div className="lp-ctas">
            {action}
            <MagneticLink href="/s/new" variant="ghost">
              Try your own data
            </MagneticLink>
          </div>
          <nav className="lp-links jn-links" aria-label="More">
            {others.map((r) => (
              <Link key={r.name} href={`/replays/${r.name}`}>
                {humanName(r.name)}
              </Link>
            ))}
            <Link href="/replays">All replays</Link>
            <button type="button" onClick={() => goBeat.current("record")}>
              The full record ↓
            </button>
          </nav>
        </>
      );
    }
    case "record":
    default:
      return (
        <div className="jn-pill">
          <span>The full record</span>
          <button type="button" onClick={() => goBeat.current("map")}>
            <span aria-hidden>↑</span> Back to the map
          </button>
        </div>
      );
  }
}

/** In-place crossfade of one changing part (the panel around it never dims). */
function Swap({ k, children, inline }: { k: string | number; children: ReactNode; inline?: boolean }) {
  // a soft focus pull: the old lines lift and blur away while the new ones settle in from just below
  const d = inline ? 4 : 10;
  const anim = {
    initial: { opacity: 0, y: d, filter: "blur(5px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.34, ease: EASE, delay: 0.04 } },
    exit: { opacity: 0, y: -d * 0.7, filter: "blur(5px)", transition: { duration: 0.15, ease: [0.4, 0, 1, 1] as const } },
  };
  if (inline)
    return (
      <span className="jn-swap" data-inline="">
        <AnimatePresence initial={false}>
          <motion.span key={k} className="jn-swap-item" {...anim}>
            {children}
          </motion.span>
        </AnimatePresence>
      </span>
    );
  return (
    <div className="jn-swap">
      <AnimatePresence initial={false}>
        <motion.div key={k} className="jn-swap-item" {...anim}>
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

type CardProps = { store: Store; view: RunView; J: JourneyFacts; onDetails: (id: string) => void };

function useIdea(store: Store, lo: number, hi: number) {
  const idea = useSyncExternalStore(
    store.sub,
    () => store.get().idea,
    () => store.get().idea,
  );
  return Math.min(hi, Math.max(lo, idea ?? lo));
}

/** One card for every idea up to the last keep: eyebrow, frame and strip stay; the idea's own lines crossfade. */
function IdeaCard({ store, view, J, onDetails }: CardProps) {
  const index = useIdea(store, 0, Math.min(J.lastKeep, J.n - 1));
  const x = view.experiments[index];
  if (!x) return null;
  const v = plainVerdict(x);
  const metric = view.metric;
  const kept = keptThrough(J, index);
  return (
    <>
      <p className="rp-kicker">
        Idea{" "}
        <Swap k={index} inline>
          {index + 1}
        </Swap>{" "}
        <span className="jn-of">of {view.experiments.length}</span>
      </p>
      <Swap k={index}>
        <h2 className="rp-h2 jn-idea">
          <span className="rp-tried">Tried</span> {plainIdea(x.idea)}.
        </h2>
        <p className="rp-verdict" data-tone={v.tone}>
          {v.text} <span aria-hidden>→</span> <strong>{v.outcome}</strong>
        </p>
        <div className="rp-pair">
          <div className="lp-stat">
            <ScrambleNumber className="lp-stat-v" value={x.cv ? displayScore(metric, x.cv.mean) : "—"} duration={0.5} />
            <span className="lp-stat-k">its score in testing</span>
          </div>
          <div className="lp-stat">
            <span className="lp-stat-v rp-dim">{x.bestMeanAfter != null ? displayScore(metric, x.bestMeanAfter) : "—"}</span>
            <span className="lp-stat-k">
              best so far · <span className="lp-signal">{kept}</span> kept
            </span>
          </div>
        </div>
      </Swap>
      <div className="rp-card-links">
        <button type="button" onClick={() => onDetails(x.id)}>
          Code and details <span aria-hidden>↓</span>
        </button>
      </div>
    </>
  );
}

/** The ideas after the last keep: one message; a ticker line steps through the misses in place. */
function TailCard({ store, view, J, onDetails }: CardProps) {
  const exps = view.experiments;
  const first = J.lastKeep + 1;
  const index = useIdea(store, first, J.n - 1);
  const x = exps[index];
  const best = exps.find((e) => e.id === view.bestId);
  if (!x) return null;
  const v = plainVerdict(x);
  return (
    <>
      <p className="rp-kicker">
        Ideas {first + 1}–{J.n} <span className="jn-of">of {J.n}</span>
      </p>
      {J.keeps.length > 1 ? (
        <>
          <RevealHeading className="lp-h2 jn-tail-h">It kept searching.</RevealHeading>
          <p className="lp-sub">
            {J.tailN} more idea{J.tailN === 1 ? "" : "s"} after its last win. None was good enough to keep.
          </p>
        </>
      ) : (
        <>
          {/* Only the starting model was kept: say so plainly instead of implying an earlier win. */}
          <RevealHeading className="lp-h2 jn-tail-h">Nothing beat the start.</RevealHeading>
          <p className="lp-sub">
            None of the {J.tailN} idea{J.tailN === 1 ? "" : "s"} beat the starting model by more than chance. The simple model was already near the ceiling.
          </p>
        </>
      )}
      <div className="jn-ticker">
        <p className="jn-ticker-k">
          <span>
            {exps[first]?.id} … {exps[J.n - 1]?.id}
          </span>
          <Swap k={index} inline>
            {index - first + 1} of {J.tailN}
          </Swap>
        </p>
        <Swap k={index}>
          <p className="jn-ticker-line">
            <span className="rp-mono jn-ticker-id">{x.id}</span> <span className="rp-tried">Tried</span> {plainIdea(x.idea)}{" "}
            <span className="jn-ticker-v" data-tone={v.tone}>
              → {v.outcome}
            </span>
          </p>
        </Swap>
      </div>
      {best?.cv && (
        <div className="lp-stat">
          <span className="lp-stat-v">{displayScore(view.metric, best.cv.mean)}</span>
          <span className="lp-stat-k">the best still stands</span>
        </div>
      )}
      <div className="rp-card-links">
        <button type="button" onClick={() => onDetails(x.id)}>
          Code and details <span aria-hidden>↓</span>
        </button>
      </div>
    </>
  );
}

/* ---- the progress strip: every idea, bar height = score, amber = kept ---- */

function IdeaStrip({ view, store, goIdea, on }: RailProps & { on: boolean }) {
  const idea = useSyncExternalStore(
    store.sub,
    () => store.get().idea,
    () => store.get().idea,
  );
  const exps = view.experiments;
  const n = exps.length;
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const heights = useMemo(() => {
    const s = exps.map((x) => x.cv?.mean ?? null);
    const v = s.filter((x): x is number => x != null);
    if (!v.length) return s.map(() => 0.2);
    // a robust floor: one bad idea far below shouldn't flatten the rest
    const sorted = [...v].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.1)];
    const hi = sorted[sorted.length - 1];
    const span = Math.max(1e-12, hi - lo);
    return s.map((x) => (x == null ? 0 : 0.12 + 0.88 * Math.min(1, Math.max(0, (x - lo) / span))));
  }, [exps]);
  if (n === 0) return null;
  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(n - 1, Math.max(0, Math.floor(((clientX - r.left) / Math.max(1, r.width)) * n)));
  };
  const cur = idea ?? 0;
  const x = exps[cur];
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const k: Record<string, number> = { Home: -cur, End: n - 1 - cur, PageUp: -5, PageDown: 5, ArrowUp: 1, ArrowDown: -1 };
    if (!(e.key in k)) return; // ←/→ are handled page-wide
    e.preventDefault();
    goIdea.current(Math.min(n - 1, Math.max(0, cur + k[e.key])));
  };
  const hx = hover != null ? exps[hover] : null;
  return (
    <div className="jn-strip" data-on={on ? "" : undefined} aria-hidden={!on}>
      <div className="jn-strip-head" aria-hidden>
        <span className="jn-strip-legend">
          <i data-k="keep" /> kept <i data-k="discard" /> dropped
        </span>
        <span>{hx ? `Idea ${hover! + 1}: ${plainIdea(hx.idea)}` : "← → to step through the ideas"}</span>
      </div>
      <div
        ref={track}
        className="jn-strip-track"
        role="slider"
        tabIndex={on ? 0 : -1}
        aria-label="Ideas, in order"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={cur + 1}
        aria-valuetext={
          x ? `Idea ${cur + 1} of ${n}: ${plainIdea(x.idea)}, ${x.status === "keep" ? "kept" : x.status === "crash" ? "crashed" : "dropped"}` : undefined
        }
        onPointerMove={(e: PointerEvent<HTMLDivElement>) => e.pointerType === "mouse" && setHover(at(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => goIdea.current(at(e.clientX))}
        onKeyDown={key}
      >
        {exps.map((e, i) => (
          <span
            key={e.id}
            className="jn-bar"
            data-k={e.status}
            data-on={idea === i ? "" : undefined}
            data-past={idea != null && i < idea ? "" : undefined}
            data-hover={hover === i ? "" : undefined}
            style={{ "--h": heights[i] } as CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}
