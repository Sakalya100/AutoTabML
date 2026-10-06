"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnyEvent, EventType } from "@/lib/events";
import { fmtCost, fmtDuration } from "@/lib/format";
import { formatScore } from "@/lib/metrics";
import { buildView, type RunView as View } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { ProposerBadge } from "./badges";
import { DataProfilePanel } from "./data-profile";
import { DetailPanel } from "./detail-panel";
import { EvolutionChart } from "./evolution-chart";
import { Ledger } from "./ledger";
import { ReefPanel } from "./reef-panel";
import { FinalScores, StopReport } from "./stop-report";

interface Props {
  mode: "replay" | "live";
  events: AnyEvent[];
  record: RunRecord | null;
  title: string;
  subtitle?: React.ReactNode;
  /** Replay: start playing from the first event. */
  autoplay?: boolean;
  /** Live mode: status strip + cancel, rendered above the chart. */
  liveBar?: React.ReactNode;
  plannedExperiments?: number | null;
}

// Per-event pacing at 1× — decisions and the stop get a beat so the eye can follow the chart.
const PACE: Record<EventType, number> = {
  run_started: 700,
  experiment_started: 260,
  llm_call: 120,
  sandbox_finished: 260,
  experiment_scored: 320,
  decision: 620,
  stopped: 1100,
  run_finished: 900,
};
const SPEEDS = [1, 2, 4] as const;

export function RunView({ mode, events, record, title, subtitle, autoplay, liveBar, plannedExperiments }: Props) {
  const replay = mode === "replay";
  const [cursor, setCursor] = useState(replay && autoplay ? 1 : events.length);
  const [playing, setPlaying] = useState(replay && !!autoplay);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [pinned, setPinned] = useState<string | null>(null);

  const shown = replay ? Math.min(cursor, events.length) : events.length;
  const view = useMemo(() => buildView(events.slice(0, shown), record), [events, shown, record]);
  const full = useMemo(() => (replay ? buildView(events, record) : null), [replay, events, record]);

  // Playback clock.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!replay || !playing || cursor >= events.length) return;
    const next = events[cursor];
    timer.current = setTimeout(() => setCursor((c) => c + 1), PACE[next.type] / speed);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [replay, playing, cursor, events, speed]);

  // Selection follows the action unless the user picked an experiment.
  const followed = view.current?.id ?? view.experiments.at(-1)?.id ?? null;
  const selectedId = pinned && view.experiments.some((x) => x.id === pinned) ? pinned : followed;
  const selected = view.experiments.find((x) => x.id === selectedId) ?? null;

  const jumpExperiment = useCallback(
    (dir: 1 | -1) => {
      setPlaying(false);
      // Move to just after the next/previous decision event.
      const idx = events.map((e, i) => (e.type === "decision" || e.type === "run_finished" ? i + 1 : -1)).filter((i) => i > 0);
      if (dir === 1) setCursor(idx.find((i) => i > cursor) ?? events.length);
      else setCursor([...idx].reverse().find((i) => i < cursor) ?? 1);
    },
    [events, cursor],
  );

  const best = view.experiments.find((x) => x.id === view.bestId);
  const elapsed = view.startedAt && view.lastTs ? (Date.parse(view.lastTs) - Date.parse(view.startedAt)) / 1000 : null;
  const stopRule = (view.config.stop_rule ?? {}) as Record<string, unknown>;
  const cfgMax = view.config.max_experiments ?? stopRule.max_experiments;
  const planned = plannedExperiments ?? (typeof cfgMax === "number" ? cfgMax : null);

  return (
    <div className="mx-auto max-w-[1240px] px-4 pt-8 pb-16 sm:px-6">
      <header className="rise">
        <div className="flex flex-wrap items-center gap-3">
          <ProposerBadge proposer={view.proposer ?? record?.proposer ?? null} />
          {view.task?.description && <span className="text-sm text-ink-3">“{view.task.description}”</span>}
        </div>
        <h1 className="mt-3 font-display text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.02] tracking-tight">{title}</h1>
        {subtitle && <div className="mt-2 text-ink-2">{subtitle}</div>}
        <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-y border-rule py-3 text-sm">
          <Fact label="experiments" value={`${view.experiments.length}${planned && mode === "live" ? ` / ${planned}` : ""}`} />
          <Fact label={`best ${view.metric ?? ""}`.trim()} value={best?.cv ? `${formatScore(view.metric, best.cv.mean)}` : "—"} accent />
          <Fact label="best id" value={view.bestId ?? "—"} />
          <Fact label="LLM cost" value={fmtCost(view.final?.totalCostUsd ?? view.totalCostUsd)} />
          <Fact label="elapsed" value={fmtDuration(view.final?.wallTimeS ?? elapsed)} />
          <Fact label="state" value={phaseLabel(view)} />
        </dl>
      </header>

      {liveBar}

      <div className="mt-6">
        <ReefPanel view={view} domainView={full} selectedId={selectedId} focusId={pinned} onSelect={setPinned} />
        {replay && (
          <ReplayControls
            cursor={shown}
            total={events.length}
            playing={playing && cursor < events.length}
            speed={speed}
            label={eventLabel(events[shown - 1])}
            onPlay={() => {
              if (cursor >= events.length) {
                setCursor(1);
                setPlaying(true);
              } else setPlaying((p) => !p);
            }}
            onSeek={(c) => {
              setPlaying(false);
              setCursor(c);
            }}
            onStep={jumpExperiment}
            onSpeed={setSpeed}
          />
        )}
      </div>

      <section className="mt-8" aria-label="Evolution chart">
        <EvolutionChart
          view={view}
          domainView={full}
          plannedExperiments={replay ? (full?.experiments.length ?? null) : planned}
          selectedId={selectedId}
          onSelect={(id) => {
            setPinned(id);
          }}
        />
      </section>

      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
        <Ledger view={view} selectedId={selectedId} onSelect={setPinned} />
        <div className="lg:sticky lg:top-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={selected?.id ?? "none"}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
            >
              <DetailPanel view={view} exp={selected} live={mode === "live"} />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <motion.div
        key={view.phase === "stopped" || view.phase === "finished" ? "stopped" : "open"}
        initial={view.stop ? { opacity: 0, y: 16 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"
      >
        <StopReport view={view} />
        <FinalScores view={view} />
      </motion.div>

      <div className="mt-12">
        <DataProfilePanel profile={view.profile ?? full?.profile ?? null} />
      </div>
    </div>
  );
}

function phaseLabel(v: View): string {
  if (v.phase === "finished") return "finished";
  if (v.phase === "stopped") return "scoring locked test";
  if (v.phase === "running") return v.current ? `running ${v.current.id}` : "deciding";
  return "starting";
}

function eventLabel(e: AnyEvent | undefined): string {
  if (!e) return "";
  const id = "exp_id" in e && e.exp_id ? `${e.exp_id} · ` : "";
  return `${id}${e.type.replace(/_/g, " ")}`;
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{label}</dt>
      <dd className={`font-mono tabular ${accent ? "text-best" : "text-ink"}`}>{value}</dd>
    </div>
  );
}

function ReplayControls(p: {
  cursor: number;
  total: number;
  playing: boolean;
  speed: number;
  label: string;
  onPlay: () => void;
  onSeek: (c: number) => void;
  onStep: (d: 1 | -1) => void;
  onSpeed: (s: (typeof SPEEDS)[number]) => void;
}) {
  const btn = "grid size-9 place-items-center rounded-full border border-rule text-ink-2 transition-colors hover:border-rule-strong hover:text-ink";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 sm:flex-nowrap">
      <div className="flex items-center gap-1.5">
        <button className={btn} onClick={() => p.onStep(-1)} aria-label="Previous experiment" title="Previous experiment">
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path d="M11 3 5 8l6 5z" fill="currentColor" />
            <rect x="3" y="3" width="1.6" height="10" fill="currentColor" />
          </svg>
        </button>
        <button
          className="grid size-11 place-items-center rounded-full bg-ink text-paper transition-transform active:scale-95"
          onClick={p.onPlay}
          aria-label={p.playing ? "Pause replay" : "Play replay"}
        >
          {p.playing ? (
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
              <rect x="4" y="3" width="3" height="10" fill="currentColor" />
              <rect x="9" y="3" width="3" height="10" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="ml-0.5 size-4" aria-hidden>
              <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
            </svg>
          )}
        </button>
        <button className={btn} onClick={() => p.onStep(1)} aria-label="Next experiment" title="Next experiment">
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path d="m5 3 6 5-6 5z" fill="currentColor" />
            <rect x="11.4" y="3" width="1.6" height="10" fill="currentColor" />
          </svg>
        </button>
      </div>
      <label className="order-last flex w-full min-w-0 items-center gap-3 sm:order-none sm:flex-1">
        <span className="sr-only">Replay position</span>
        <input
          type="range"
          min={1}
          max={p.total}
          value={p.cursor}
          onChange={(e) => p.onSeek(Number(e.target.value))}
          className="h-1 w-full cursor-pointer accent-[var(--best)]"
        />
      </label>
      <div className="ml-auto flex items-center gap-3 text-xs sm:ml-0">
        <span className="hidden w-48 truncate text-right font-mono text-ink-3 md:inline">{p.label}</span>
        <span className="font-mono text-ink-3 tabular">
          {p.cursor}/{p.total}
        </span>
        <div className="flex rounded-full border border-rule p-0.5" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => p.onSpeed(s)}
              aria-pressed={p.speed === s}
              className={`rounded-full px-2 py-0.5 font-mono transition-colors ${p.speed === s ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"}`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
