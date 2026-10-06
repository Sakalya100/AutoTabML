"use client";

import { AnimatePresence, motion } from "motion/react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { formatScore, metricInfo } from "@/lib/metrics";
import type { RunView } from "@/lib/run-state";
import { REEF, type SceneChapter } from "@/lib/scene/contract";
import { ceilingScore } from "@/lib/scene/layout";
import { useWebGLAvailable } from "@/lib/scene/webgl";

const ReefCanvas = dynamic(() => import("./reef/reef-canvas"), { ssr: false, loading: () => <ReefSkeleton /> });

type Moment = "ceiling" | "test" | null;

interface Props {
  view: RunView;
  domainView?: RunView | null;
  selectedId: string | null;
  /** The user's pick (the camera eases toward it); playback follow does not move the camera. */
  focusId: string | null;
  onSelect: (id: string) => void;
}

/** The hero of the run page: the living reef, with a legend and the two narrative moments of a run. */
export function ReefPanel({ view, domainView, selectedId, focusId, onSelect }: Props) {
  const webgl = useWebGLAvailable();

  // Phase transitions seen while watching (not on a cold load at the end) become short camera "moments".
  const [seenPhase, setSeenPhase] = useState(view.phase);
  const [moment, setMoment] = useState<Moment>(null);
  if (seenPhase !== view.phase) {
    setSeenPhase(view.phase);
    if (view.phase === "stopped" && seenPhase === "running") setMoment("ceiling");
    else if (view.phase === "finished" && (seenPhase === "stopped" || seenPhase === "running")) setMoment("test");
    else setMoment(null);
  }
  useEffect(() => {
    if (!moment) return;
    const t = setTimeout(() => setMoment(null), moment === "ceiling" ? 5200 : 6000);
    return () => clearTimeout(t);
  }, [moment]);

  const chapter: SceneChapter = moment ?? (view.phase === "empty" || (view.phase === "running" && view.experiments.length === 0) ? "nutrients" : "overview");

  if (webgl === false) return null;
  const metric = view.metric;
  const ceil = ceilingScore(view);

  return (
    <section aria-label="The reef: every experiment as a branch" className="relative isolate overflow-hidden rounded-2xl border border-rule bg-[#03060d] shadow-[0_30px_80px_-40px_rgba(3,6,13,0.6)]">
      <div className="relative h-[clamp(360px,62vh,640px)]">
        {webgl ? (
          <ReefCanvas
            view={view}
            domainView={domainView}
            selectedId={selectedId}
            focusId={focusId}
            onSelect={onSelect}
            chapter={chapter}
            quality="full"
            interactive
            autoRotate
            className="absolute inset-0"
          />
        ) : (
          <ReefSkeleton />
        )}

        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-[#03060d]/80 via-[#03060d]/35 to-transparent" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[#03060d]/80 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-4 sm:p-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8fb3c7]">The reef</p>
            <p className="mt-1 hidden max-w-[34ch] text-[13px] leading-snug text-[#c9dde8] sm:block">
              Each branch is an experiment, grown from its parent. Height is the CV score.
            </p>
          </div>
          <PhasePill view={view} />
        </div>

        <Legend />

        <AnimatePresence>
          {moment === "ceiling" && (
            <Moment key="ceiling" kicker="Stop rule fired" title="The ceiling reveals itself">
              {ceil != null && (
                <>
                  Fitted asymptote ≈ <span className="font-mono">{formatScore(metric, ceil)}</span> {metricInfo(metric).label}. More experiments are
                  not expected to beat the noise.
                </>
              )}
            </Moment>
          )}
          {moment === "test" && view.final && (
            <Moment key="test" kicker="Locked test opened" title="The pearl rises" top>
              test <span className="font-mono">{formatScore(metric, view.final.testScore)}</span> vs select{" "}
              <span className="font-mono">{formatScore(metric, view.final.selectScore)}</span> — the vertical gap is the optimism gap.
            </Moment>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

function Moment({ kicker, title, children, top }: { kicker: string; title: string; children: React.ReactNode; top?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      className={`pointer-events-none absolute inset-x-0 flex justify-center px-4 ${top ? "top-24" : "bottom-14"}`}
      role="status"
    >
      <div className="max-w-[46ch] rounded-xl border border-white/10 bg-[#03060d]/70 px-5 py-3 text-center backdrop-blur-md">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: REEF.surfaceLight }}>
          {kicker}
        </p>
        <p className="mt-1 font-display text-[clamp(1.5rem,3.2vw,2.25rem)] leading-tight text-[#f3f8fb]">{title}</p>
        <p className="mt-1 text-[13px] leading-snug text-[#b9cfdb]">{children}</p>
      </div>
    </motion.div>
  );
}

function PhasePill({ view }: { view: RunView }) {
  const text =
    view.phase === "finished" ? "finished · test opened" : view.phase === "stopped" ? "ceiling reached" : view.current ? `growing ${view.current.id}` : view.phase === "running" ? "deciding" : "starting";
  const live = view.phase === "running";
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={text}
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 6 }}
        transition={{ duration: 0.25 }}
        className="flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-[#03060d]/60 px-3 py-1 font-mono text-[11px] text-[#cfe3ee] backdrop-blur"
      >
        <span className="relative flex size-2">
          {live && <span className="absolute inline-flex size-full animate-ping rounded-full opacity-60" style={{ background: REEF.keep }} />}
          <span className="relative inline-flex size-2 rounded-full" style={{ background: view.phase === "running" ? REEF.keep : view.phase === "empty" ? "#55606f" : REEF.best }} />
        </span>
        {text}
      </motion.span>
    </AnimatePresence>
  );
}

const LEGEND: { label: string; color: string; kind: "dot" | "ring" | "line" }[] = [
  { label: "kept", color: REEF.keep, kind: "dot" },
  { label: "best lineage", color: REEF.best, kind: "dot" },
  { label: "discarded (bleached)", color: REEF.discard, kind: "dot" },
  { label: "crashed", color: REEF.crash, kind: "dot" },
  { label: "noise halo", color: REEF.halo, kind: "ring" },
  { label: "ceiling", color: REEF.surfaceLight, kind: "line" },
];

function Legend() {
  return (
    <ul className="pointer-events-none absolute bottom-3 left-4 right-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#a9c2d0] sm:left-5">
      {LEGEND.map((l) => (
        <li key={l.label} className="flex items-center gap-1.5">
          {l.kind === "dot" && <span className="size-2 rounded-full" style={{ background: l.color, boxShadow: `0 0 8px ${l.color}` }} />}
          {l.kind === "ring" && <span className="size-2.5 rounded-full border" style={{ borderColor: l.color }} />}
          {l.kind === "line" && <span className="h-px w-3" style={{ background: l.color, boxShadow: `0 0 6px ${l.color}` }} />}
          {l.label}
        </li>
      ))}
      <li className="ml-auto hidden text-[#6f8a99] sm:block">drag to orbit · click a branch</li>
    </ul>
  );
}

export function ReefSkeleton() {
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: "radial-gradient(90% 70% at 50% 0%, #0d3346 0%, #071a2b 35%, #03060d 75%)" }}>
      <div className="absolute inset-x-0 top-0 h-1/2 animate-pulse opacity-40" style={{ background: "linear-gradient(180deg, rgba(191,246,255,0.18), transparent)" }} />
    </div>
  );
}
