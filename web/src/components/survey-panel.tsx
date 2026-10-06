"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useWebGLAvailable } from "@/lib/gl";
import { formatScore, metricInfo } from "@/lib/metrics";
import type { RunView } from "@/lib/run-state";
import { SURVEY } from "@/lib/survey/contract";
import { ceilingScore, momentFor, MOMENT_MS, poseFor, surveySummary, type SurveyMoment } from "@/lib/terra";
import { SurveyCanvas, SurveySkeleton } from "./survey-source";

interface Props {
  view: RunView;
  domainView?: RunView | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The run is growing on screen (live or simulate): the camera follows the bead. */
  staging: boolean;
  /** Height classes for the frame. */
  heightClass?: string;
  /** Narrow column: the key folds behind a toggle on small screens. */
  compact?: boolean;
  quality?: "full" | "lite";
  className?: string;
  /** Overrides the status line (e.g. "cancelled"). */
  statusText?: string;
}

const EASE = [0.22, 1, 0.36, 1] as const;

/** The survey world framed for a run page: status, key, projection note and the two narrative moments. */
export function SurveyPanel({ view, domainView, selectedId, onSelect, staging, heightClass = "h-[clamp(360px,62vh,640px)]", compact, quality = "full", className = "", statusText }: Props) {
  const webgl = useWebGLAvailable();
  const [keyOpen, setKeyOpen] = useState(false);

  // Phase transitions seen while watching (not a cold load at the end) become short camera moments.
  const [seenPhase, setSeenPhase] = useState(view.phase);
  const [moment, setMoment] = useState<SurveyMoment>(null);
  if (seenPhase !== view.phase) {
    setSeenPhase(view.phase);
    setMoment(momentFor(seenPhase, view.phase));
  }
  useEffect(() => {
    if (!moment) return;
    const t = setTimeout(() => setMoment(null), MOMENT_MS[moment]);
    return () => clearTimeout(t);
  }, [moment]);

  if (webgl === false) return null; // the 2D evolution chart below carries the run on its own
  const pose = poseFor({ moment, staging, phase: view.phase });
  const metric = view.metric;
  const ceil = ceilingScore(view);

  return (
    <section aria-label="Survey map of the run" className={`terra-frame relative isolate overflow-hidden rounded-xl ${className}`}>
      <div className={`relative ${heightClass}`}>
        {webgl ? (
          <SurveyCanvas
            view={view}
            domainView={domainView}
            pose={pose}
            selectedId={selectedId}
            onSelect={onSelect}
            quality={quality}
            interactive
            className="absolute inset-0"
            ariaLabel={surveySummary(view)}
          />
        ) : (
          <SurveySkeleton />
        )}

        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-[#05070a]/85 to-transparent" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#05070a]/90 to-transparent" />

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 px-4 pt-3.5 sm:px-5">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-[#d9d3c4]/60">Survey</p>
          <Status view={view} override={statusText} />
        </div>

        <AnimatePresence>
          {moment === "ceiling" && (
            <Moment key="ceiling" kicker="stop rule fired" title="The clouds settle on the ceiling">
              {ceil != null ? (
                <>
                  fitted asymptote ≈ <span className="text-[#ece7dc]">{formatScore(metric, ceil)}</span> {metricInfo(metric).label}
                </>
              ) : (
                "further probes are not expected to clear the noise"
              )}
            </Moment>
          )}
          {moment === "truth" && view.final && (
            <Moment key="truth" kicker="locked test opened" title="One beam of truth">
              test <span className="text-[#eaf6ff]">{formatScore(metric, view.final.testScore)}</span> vs select {formatScore(metric, view.final.selectScore)} · the gap is the optimism gap
            </Moment>
          )}
        </AnimatePresence>

        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 px-4 pb-3 sm:px-5">
          <Key className={compact ? "hidden lg:flex" : "hidden sm:flex"} />
          <p className={`pointer-events-none font-mono text-[10px] text-[#d9d3c4]/45 ${compact ? "lg:hidden" : "sm:hidden"}`}>drag · hold to sonar</p>
          <button
            type="button"
            onClick={() => setKeyOpen((o) => !o)}
            aria-expanded={keyOpen}
            className={`shrink-0 rounded-full border border-[#d9d3c4]/20 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[#d9d3c4]/70 transition-colors hover:border-[#d9d3c4]/45 hover:text-[#ece7dc] ${compact ? "lg:hidden" : "sm:hidden"}`}
          >
            key
          </button>
        </div>
        <AnimatePresence>
          {keyOpen && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4, transition: { duration: 0.15 } }}
              transition={{ duration: 0.25, ease: EASE }}
              className={`absolute inset-x-0 bottom-0 bg-[#05070a]/95 px-4 pt-3 pb-9 ${compact ? "lg:hidden" : "sm:hidden"}`}
            >
              <Key className="flex" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

function Moment({ kicker, title, children }: { kicker: string; title: string; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.5 } }}
      transition={{ duration: 1.2, ease: EASE }}
      className="pointer-events-none absolute inset-x-0 top-10 flex flex-col items-center px-6 text-center"
      role="status"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#ffb547]">{kicker}</p>
      <p className="mt-1.5 font-display text-[clamp(1.4rem,3vw,2.2rem)] leading-tight text-[#ece7dc] [text-shadow:0_2px_24px_#05070a]">{title}</p>
      <p className="mt-1 font-mono text-[11.5px] text-[#d9d3c4]/70 tabular [text-shadow:0_1px_12px_#05070a]">{children}</p>
    </motion.div>
  );
}

function Status({ view, override }: { view: RunView; override?: string }) {
  const text =
    override ??
    (view.phase === "finished"
      ? "mapped · test opened"
      : view.phase === "stopped"
        ? "under the ceiling"
        : view.current
          ? `probing ${view.current.id}`
          : view.phase === "running"
            ? "choosing a bearing"
            : "landing");
  const live = view.phase === "running" && !override;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.p
        key={text}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
        transition={{ duration: 0.2, ease: EASE }}
        className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-[#d9d3c4]/80"
      >
        <span className="relative flex size-1.5" aria-hidden>
          {live && <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#ffb547] opacity-60" />}
          <span className={`relative inline-flex size-1.5 rounded-full ${live ? "bg-[#ffb547]" : override ? "bg-[#ff5a3c]" : "bg-[#d9d3c4]/70"}`} />
        </span>
        {text}
      </motion.p>
    </AnimatePresence>
  );
}

type Glyph = "kept" | "discarded" | "crash" | "mercury" | "mist" | "cloud" | "truth";
const KEY: { glyph: Glyph; label: string }[] = [
  { glyph: "kept", label: "kept probe" },
  { glyph: "discarded", label: "discarded" },
  { glyph: "crash", label: "crash" },
  { glyph: "mercury", label: "current best" },
  { glyph: "mist", label: "noise floor" },
  { glyph: "cloud", label: "ceiling" },
  { glyph: "truth", label: "locked test" },
];

/** The in-frame key, drawn with the world's own tokens; ends with the honest note about the map projection. */
export function Key({ className = "" }: { className?: string }) {
  return (
    <div className={`pointer-events-none min-w-0 flex-col gap-1.5 ${className}`}>
      <ul className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[10.5px] text-[#d9d3c4]/75">
        {KEY.map((k) => (
          <li key={k.glyph} className="flex items-center gap-1.5">
            <KeyGlyph glyph={k.glyph} />
            {k.label}
          </li>
        ))}
      </ul>
      <p className="font-mono text-[10px] text-[#d9d3c4]/45">map projection: position = idea family &amp; change size · height = CV score</p>
    </div>
  );
}

function KeyGlyph({ glyph }: { glyph: Glyph }) {
  const s = { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": true } as const;
  switch (glyph) {
    case "kept":
      return (
        <svg {...s}>
          <circle cx="6" cy="6" r="2.6" fill={SURVEY.signal} />
          <circle cx="6" cy="6" r="4.6" fill="none" stroke={SURVEY.signal} strokeOpacity=".35" />
        </svg>
      );
    case "discarded":
      return (
        <svg {...s}>
          <path d="M6 2v8M4 10h4" stroke={SURVEY.contour} strokeOpacity=".55" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "crash":
      return (
        <svg {...s}>
          <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke={SURVEY.crash} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "mercury":
      return (
        <svg {...s}>
          <defs>
            <radialGradient id="kg-merc" cx="35%" cy="30%" r="75%">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset=".45" stopColor="#aeb6bf" />
              <stop offset="1" stopColor="#2a3038" />
            </radialGradient>
          </defs>
          <circle cx="6" cy="6" r="4" fill="url(#kg-merc)" />
        </svg>
      );
    case "mist":
      return (
        <svg {...s}>
          <rect x="1" y="5" width="10" height="4" rx="2" fill={SURVEY.mist} fillOpacity=".35" />
        </svg>
      );
    case "cloud":
      return (
        <svg {...s}>
          <path d="M1 6h10" stroke={SURVEY.cloud} strokeWidth="1.4" strokeDasharray="2 1.5" />
        </svg>
      );
    case "truth":
      return (
        <svg {...s}>
          <path d="M6 1v10" stroke={SURVEY.truth} strokeWidth="1.4" />
          <path d="M6 1v10" stroke={SURVEY.truth} strokeOpacity=".25" strokeWidth="4" />
        </svg>
      );
  }
}
