"use client";

/*
 * The finished run, led by its world (docs/creative/02-direction.md: one world, travel as navigation, one message).
 * A full-bleed survey of the complete run — prebuilt land, ball on the summit — with one fixed copy slot:
 *   summary  → what was asked, what happened, the result, in plain words;
 *   explore  → the timeline is engaged: one card for the experiment under the playhead.
 * Scrubbing the timeline rolls the ball along the climb and the camera follows it, exactly like the landing's scroll:
 * the UI writes a target position, one rAF loop eases it and writes the SurveyScrub ref the world reads every frame.
 * React only hears discrete changes (the experiment under the playhead, the mode).
 */

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { EvolutionChart } from "@/components/evolution-chart";
import { EASE, MagneticLink } from "@/components/landing/primitives";
import { SurveyCanvas } from "@/components/survey-source";
import { useWebGLAvailable } from "@/lib/gl";
import { metricInfo } from "@/lib/metrics";
import type { RunView } from "@/lib/run-state";
import { askedOf, beadAt, displayScore, keptIndices, outcomeOf, plainGap, plainIdea, plainVerdict, proposerNote } from "@/lib/story";
import type { SurveyScrub } from "@/lib/survey/contract";
import { RevealHeading, ScrambleNumber } from "./motion";
import { Timeline } from "./timeline";

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

/** Playhead smoothing (1/s): a keyboard step or a click glides; a drag follows closely. */
const GLIDE = 7;
/** Summary ↔ explore camera move (1/s): slow and settled, like the landing's section blends. */
const MODE = 2.6;

interface Props {
  view: RunView;
  name: string;
  /** Primary action in the summary (replays: simulate; live runs: none). */
  action?: ReactNode;
  secondary?: ReactNode;
  /** Experiment picked elsewhere on the page (ledger, chart): the playhead goes there. */
  focusId: string | null;
  onSelect: (id: string) => void;
  /** Scroll to the technical details for the current experiment. */
  onDetails: () => void;
  kicker?: string;
  note?: ReactNode;
}

export function RunStage({ view, name, action, secondary, focusId, onSelect, onDetails, kicker, note }: Props) {
  const narrow = useSyncExternalStore(narrowQ.sub, narrowQ.get, () => false);
  const reduced = useSyncExternalStore(reducedQ.sub, reducedQ.get, () => false);
  const webgl = useWebGLAvailable();
  const exps = view.experiments;
  const n = exps.length;
  const keeps = useMemo(() => keptIndices(view), [view]);
  const summitT = Math.max(0, keeps.length - 1);

  const [mode, setMode] = useState<"summary" | "explore">("summary");
  const [at, setAt] = useState(() => exps.find((x) => x.id === view.bestId)?.index ?? Math.max(0, n - 1));
  const target = useRef(at);
  const atRef = useRef(at);
  const live = useRef({ t: at, w: 0, mode: 0 });
  const scrub = useRef<SurveyScrub | null>({
    a: "approach",
    pa: 0.35,
    b: "climb",
    pb: 0,
    w: 0,
    intro: 1,
    beadT: summitT,
    shiftX: 0,
    shiftY: 0,
    gates: { mist: 0.5, cloud: 0.35, cloudDrop: 1, truth: 1 },
  });
  const kick = useRef<() => void>(() => {});

  // One loop: ease the playhead and the summary↔explore blend, write the scrub ref. Runs only while moving.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const write = () => {
      const s = live.current;
      const sc = scrub.current!;
      const w = s.w;
      // the ball: on the summit in the summary, under the playhead while exploring (blended across the move)
      const tb = beadAt(keeps, s.t);
      sc.beadT = summitT + (tb - summitT) * w;
      sc.a = "approach";
      sc.pa = 0.35;
      sc.b = "climb";
      sc.pb = n > 1 ? Math.min(0.58, (s.t / (n - 1)) * 0.58) : 0;
      sc.w = w;
      sc.shiftX = narrow ? 0 : 0.2;
      sc.shiftY = narrow ? 0.27 : 0.04;
      const g = sc.gates!;
      g.mist = 0.45 + 0.15 * w;
      g.cloud = 0.4 * (1 - w) + 0.12 * w;
      g.cloudDrop = 1;
      g.truth = 0;
      // keep the experiment under the playhead in frame too, not only the ball (eased in with the playhead)
      const idx = Math.round(s.t);
      sc.aimId = exps[idx]?.id ?? null;
      sc.aimW = w * (1 - Math.min(1, Math.abs(s.t - idx) * 2));
    };
    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      const s = live.current;
      const tt = target.current;
      if (reduced) {
        s.t = tt;
        s.w = s.mode;
      } else {
        s.t += (tt - s.t) * (1 - Math.exp(-GLIDE * dt));
        if (Math.abs(tt - s.t) < 0.002) s.t = tt;
        s.w += (s.mode - s.w) * (1 - Math.exp(-MODE * dt));
        if (Math.abs(s.mode - s.w) < 0.002) s.w = s.mode;
      }
      write();
      if (s.t !== tt || s.w !== s.mode) raf = requestAnimationFrame(frame);
      else last = 0;
    };
    kick.current = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    write();
    return () => {
      cancelAnimationFrame(raf);
      kick.current = () => {};
    };
  }, [keeps, summitT, n, narrow, reduced, exps]);

  const goTo = useCallback(
    (t: number, settle: boolean) => {
      const c = Math.min(n - 1, Math.max(0, t));
      target.current = settle ? Math.round(c) : c;
      live.current.mode = 1;
      const i = Math.round(c);
      setMode("explore");
      if (atRef.current !== i) {
        atRef.current = i;
        setAt(i);
        onSelect(exps[i].id);
      }
      kick.current();
    },
    [n, exps, onSelect],
  );
  const back = useCallback(() => {
    live.current.mode = 0;
    setMode("summary");
    kick.current();
  }, []);

  // A pick made elsewhere on the page moves the playhead there.
  const [seenFocus, setSeenFocus] = useState(focusId);
  if (focusId !== seenFocus) {
    setSeenFocus(focusId);
    const x = focusId ? exps.find((e) => e.id === focusId) : null;
    if (x && (x.index !== at || mode !== "explore")) {
      setAt(x.index);
      setMode("explore");
    }
  }
  useEffect(() => {
    const x = focusId ? exps.find((e) => e.id === focusId) : null;
    if (!x) return;
    atRef.current = x.index;
    if (Math.round(target.current) !== x.index || live.current.mode !== 1) {
      target.current = x.index;
      live.current.mode = 1;
      kick.current();
    }
  }, [focusId, exps]);

  // Esc returns to the summary.
  useEffect(() => {
    if (mode !== "explore") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, back]);

  const selected = exps[at] ?? null;
  const onWorldSelect = useCallback(
    (id: string) => {
      const x = exps.find((e) => e.id === id);
      if (x) goTo(x.index, true);
    },
    [exps, goTo],
  );

  return (
    <section className="rp-stage" data-mode={mode} aria-label="The run, as a map">
      <div className="rp-world">
        {webgl === false ? (
          <div className="rp-fallback">
            <EvolutionChart
              view={view}
              domainView={view}
              plannedExperiments={n}
              selectedId={mode === "explore" ? selected?.id : null}
              onSelect={onWorldSelect}
              compact
            />
          </div>
        ) : (
          <SurveyCanvas
            view={view}
            domainView={view}
            pose={mode === "explore" ? "climb" : "approach"}
            scrub={scrub}
            selectedId={mode === "explore" ? (selected?.id ?? null) : null}
            onSelect={onWorldSelect}
            quality={narrow ? "lite" : "full"}
            interactive={!narrow}
            className="absolute inset-0"
            ariaLabel={`Map of the run: ${n} ideas, each marker's height is its score. The amber trail is the path of ideas it kept.`}
          />
        )}
        <div className="rp-scrim" aria-hidden />
      </div>

      <div className="rp-rail">
        <AnimatePresence mode="wait" initial={false}>
          {mode === "summary" || !selected ? (
            <motion.div key="summary" className="rp-msg" initial={FROM} animate={IN} exit={OUT}>
              <Summary view={view} name={name} action={action} secondary={secondary} kicker={kicker} note={note} />
            </motion.div>
          ) : (
            <motion.div key={selected.id} className="rp-msg" initial={FROM} animate={IN} exit={OUT}>
              <ExperimentCard view={view} index={at} onBack={back} onDetails={onDetails} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Timeline view={view} at={mode === "explore" ? at : null} onScrub={goTo} hint={mode === "summary"} />
    </section>
  );
}

const DIM = 0.32;
const OUT = { opacity: DIM, y: -6, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] as const } };
const IN = { opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE } };
const FROM = { opacity: DIM, y: 8 };

export function Summary({
  view,
  name,
  action,
  secondary,
  kicker,
  note,
  hint,
}: {
  view: RunView;
  name: string;
  action?: ReactNode;
  secondary?: ReactNode;
  kicker?: string;
  note?: ReactNode;
  hint?: ReactNode;
}) {
  const asked = askedOf(view);
  const o = outcomeOf(view);
  const f = view.final;
  const best = view.experiments.find((x) => x.id === view.bestId);
  const label = metricInfo(view.metric).label;
  const stopped = view.stop?.reason === "ceiling" ? "It stopped on its own when progress levelled off." : o.stop ? `It ${o.stop}.` : null;
  const proposer = proposerNote(view.proposer);
  return (
    <>
      {kicker && <p className="rp-kicker">{kicker}</p>}
      <RevealHeading as="h1" className="rp-h1" pre delay={0.15}>
        {name}
      </RevealHeading>
      <dl className="rp-story">
        {asked.target && (
          <div>
            <dt>Asked</dt>
            <dd>
              Predict <span className="rp-mono">{asked.target}</span>
              {asked.kind ? <> ({asked.kind})</> : null}
              {asked.features != null && asked.rows != null ? (
                <>
                  {" "}
                  from {asked.features} columns of {asked.rows.toLocaleString("en-US")} rows.
                </>
              ) : (
                "."
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>What happened</dt>
          <dd>
            {o.tried} ideas tried, <span className="rp-signal">{o.kept} kept</span>
            {o.crashed ? `, ${o.crashed} crashed` : ""}. {stopped}
          </dd>
        </div>
        {f && (
          <div>
            <dt>Result</dt>
            <dd>
              <ScrambleNumber className="rp-score" value={displayScore(view.metric, f.testScore)} delay={0.5} duration={1.2} />
              <span className="rp-score-k">{label} on data it never saw</span>
              <span className="rp-gap">{plainGap(view.metric, f.optimismGap, best?.cv?.se)}</span>
            </dd>
          </div>
        )}
      </dl>
      {(action || secondary) && (
        <div className="lp-ctas rp-ctas">
          {action}
          {secondary}
        </div>
      )}
      {(proposer || note) && <p className="rp-note">{note ?? proposer}</p>}
      {hint}
    </>
  );
}

function ExperimentCard({ view, index, onBack, onDetails }: { view: RunView; index: number; onBack: () => void; onDetails: () => void }) {
  const x = view.experiments[index];
  const v = plainVerdict(x);
  const n = view.experiments.length;
  const metric = view.metric;
  const bestAfter = x.bestMeanAfter;
  return (
    <>
      <p className="rp-kicker">
        Idea {index + 1} of {n} <span className="rp-kicker-id">{x.id}</span>
      </p>
      <h2 className="rp-h2">
        <span className="rp-tried">Tried</span> {plainIdea(x.idea)}.
      </h2>
      <p className="rp-verdict" data-tone={v.tone}>
        {v.text} <span aria-hidden>→</span> <strong>{v.outcome}</strong>
      </p>
      <div className="rp-pair">
        <div className="lp-stat">
          <ScrambleNumber className="lp-stat-v" value={x.cv ? displayScore(metric, x.cv.mean) : "—"} duration={0.6} />
          <span className="lp-stat-k">its score in testing</span>
        </div>
        <div className="lp-stat">
          <span className="lp-stat-v rp-dim">{bestAfter != null ? displayScore(metric, bestAfter) : "—"}</span>
          <span className="lp-stat-k">best so far, after this idea</span>
        </div>
      </div>
      <div className="rp-card-links">
        <button type="button" onClick={onDetails}>
          Technical details <span aria-hidden>↓</span>
        </button>
        <button type="button" onClick={onBack}>
          <span aria-hidden>←</span> Back to the summary
        </button>
      </div>
    </>
  );
}

export function SimulateLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="lp-cta lp-cta-primary">
      <span className="relative z-10">{children}</span>
      <span aria-hidden className="lp-cta-arrow relative z-10">
        →
      </span>
    </button>
  );
}

export { MagneticLink };
