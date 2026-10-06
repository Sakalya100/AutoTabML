"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AnyEvent, EventType } from "@/lib/events";
import { buildFeed } from "@/lib/feed";
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
import { StepFeed } from "./step-feed";
import { FinalScores, StopReport } from "./stop-report";

interface Props {
  mode: "replay" | "live";
  events: AnyEvent[];
  record: RunRecord | null;
  title: string;
  subtitle?: React.ReactNode;
  /** Live mode: the run is still producing events (shows the feed + growing tree). */
  active?: boolean;
  /** Live mode: status strip + cancel, rendered under the header. */
  liveBar?: React.ReactNode;
  /** Live mode: what to say in the feed before the first event arrives. */
  emptyHint?: string;
  plannedExperiments?: number | null;
  /** Replay: open straight into the simulation (?simulate). */
  initialSimulate?: boolean;
  /** Live mode: a terminal status other than finished ("cancelled", "failed"). */
  endedAs?: string | null;
}

/**
 * Simulation pacing at 1×: the delay *before* each event appears. One experiment step
 * (start → sandbox → score → decision) is ≈1.2 s, and the next idea waits a beat after the verdict.
 */
const PACE: Record<EventType, number> = {
  run_started: 500,
  experiment_started: 420,
  llm_call: 60,
  sandbox_finished: 420,
  experiment_scored: 200,
  decision: 300,
  stopped: 1200,
  run_finished: 1700,
};
const FIRST_STEP_DELAY = 1500; // let the reader take in the "run started" message
const SPEEDS = [1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

export function RunView({ mode, events, record, title, subtitle, active, liveBar, emptyHint, plannedExperiments, initialSimulate, endedAs }: Props) {
  const live = mode === "live";
  const [simulating, setSimulating] = useState(!!initialSimulate && events.length > 0);
  const [cursor, setCursor] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<Speed>(1);
  const [pinned, setPinned] = useState<string | null>(null);

  const liveActive = live && !!active;
  // When a live run finishes, hold the feed + tree a few seconds so the locked-test moment plays out.
  const [wasActive, setWasActive] = useState(liveActive);
  const [holding, setHolding] = useState(false);
  if (wasActive !== liveActive) {
    setWasActive(liveActive);
    setHolding(!liveActive && events.length > 0);
  }
  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => setHolding(false), 6500);
    return () => clearTimeout(t);
  }, [holding]);
  const staging = liveActive || simulating || holding;
  const endState = !staging && endedAs ? endedAs : null;
  const shown = simulating ? Math.min(cursor, events.length) : events.length;
  const shownEvents = useMemo(() => events.slice(0, shown), [events, shown]);
  const view = useMemo(() => buildView(shownEvents, record), [shownEvents, record]);
  // The complete run fixes the tree's and the chart's scales, so a simulation grows without rescaling.
  const full = useMemo(() => (liveActive ? null : buildView(events, record)), [liveActive, events, record]);
  const items = useMemo(() => (staging ? buildFeed(shownEvents) : []), [staging, shownEvents]);

  // Simulation clock: one event at a time.
  const done = simulating && cursor >= events.length;
  useEffect(() => {
    if (!simulating || !playing || cursor >= events.length) return;
    const next = events[cursor];
    const base = cursor === 1 ? FIRST_STEP_DELAY : PACE[next.type];
    const t = setTimeout(() => setCursor((c) => c + 1), base / speed);
    return () => clearTimeout(t);
  }, [simulating, playing, cursor, events, speed]);

  const top = useRef<HTMLDivElement>(null);
  const scrollTop = (block: ScrollLogicalPosition = "start") => requestAnimationFrame(() => top.current?.scrollIntoView({ behavior: "smooth", block }));

  const startSimulation = () => {
    setPinned(null);
    setCursor(1);
    setPlaying(true);
    setSimulating(true);
    scrollTop();
  };
  const exitSimulation = () => {
    setSimulating(false);
    setPinned(null);
    scrollTop();
  };

  // Selection follows the action while it grows, rests on the best when finished, unless the user picked one.
  const followed = staging ? (view.current?.id ?? view.experiments.at(-1)?.id ?? null) : (view.bestId ?? view.experiments.at(-1)?.id ?? null);
  const selectedId = pinned && view.experiments.some((x) => x.id === pinned) ? pinned : followed;
  const selected = view.experiments.find((x) => x.id === selectedId) ?? null;

  const best = view.experiments.find((x) => x.id === view.bestId);
  const elapsed = view.startedAt && view.lastTs ? (Date.parse(view.lastTs) - Date.parse(view.startedAt)) / 1000 : null;
  const stopRule = (view.config.stop_rule ?? {}) as Record<string, unknown>;
  const cfgMax = view.config.max_experiments ?? stopRule.max_experiments;
  const planned = plannedExperiments ?? (typeof cfgMax === "number" ? cfgMax : null);
  const totalExps = full?.experiments.length ?? null;

  return (
    <div className="mx-auto max-w-[1320px] px-4 pt-8 pb-16 sm:px-6">
      <header className="rise">
        <div className="flex flex-wrap items-center gap-3">
          <ProposerBadge proposer={view.proposer ?? record?.proposer ?? null} />
          {view.task?.description && <span className="text-sm text-ink-3">“{view.task.description}”</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <h1 className="font-display text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.02] tracking-tight">{title}</h1>
            {subtitle && <div className="mt-2 text-ink-2">{subtitle}</div>}
          </div>
          {!staging && events.length > 0 && (
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                onClick={startSimulation}
                className="group inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-transform hover:-translate-y-px active:translate-y-0"
              >
                <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
                  <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
                </svg>
                Simulate this run
              </button>
              <Link
                href="/new"
                className="inline-flex items-center rounded-full border border-rule-strong px-5 py-2.5 text-sm text-ink-2 transition-colors hover:border-ink hover:text-ink"
              >
                {live ? "Start another run" : "Start a new run on your data"}
              </Link>
            </div>
          )}
        </div>
        <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-y border-rule py-3 text-sm">
          <Fact label="experiments" value={`${view.experiments.length}${staging && (liveActive ? planned : totalExps) ? ` / ${liveActive ? planned : totalExps}` : ""}`} />
          <Fact label={`best ${view.metric ?? ""}`.trim()} value={best?.cv ? `${formatScore(view.metric, best.cv.mean)}` : "—"} accent />
          <Fact label="best id" value={view.bestId ?? "—"} />
          {view.final && <Fact label="locked test" value={formatScore(view.metric, view.final.testScore)} />}
          <Fact label="LLM cost" value={fmtCost(view.final?.totalCostUsd ?? view.totalCostUsd)} />
          <Fact label="elapsed" value={fmtDuration(view.final?.wallTimeS ?? elapsed)} />
          <Fact label="state" value={endState ?? phaseLabel(view)} />
        </dl>
      </header>

      {liveBar}

      <div ref={top} className="scroll-mt-4" />

      <AnimatePresence mode="wait" initial={false}>
        {staging ? (
          <motion.div
            key="stage"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            {simulating && (
              <SimulationBar
                cursor={shown}
                total={events.length}
                expLabel={view.current?.id ?? view.experiments.at(-1)?.id ?? null}
                nExp={view.experiments.length}
                totalExp={totalExps}
                playing={playing && !done}
                done={done}
                speed={speed}
                onToggle={() => setPlaying((p) => !p)}
                onSpeed={setSpeed}
                onRestart={startSimulation}
                onSkip={exitSimulation}
                onExit={exitSimulation}
              />
            )}
            <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
              <div className="sticky top-0 z-10 -mx-4 bg-paper px-4 pt-2 pb-2 sm:-mx-6 sm:px-6 lg:static lg:order-2 lg:m-0 lg:p-0">
                <ReefPanel
                  statusText={endState ?? undefined}
                  view={view}
                  domainView={full}
                  selectedId={selectedId}
                  focusId={pinned}
                  onSelect={setPinned}
                  compact
                  heightClass="h-[34svh] min-h-[240px] lg:h-[min(74vh,740px)] lg:min-h-[520px]"
                />
              </div>
              <StepFeed
                items={items}
                metric={view.metric}
                selectedId={pinned}
                focusId={pinned}
                onSelect={setPinned}
                streaming={liveActive || (simulating && playing && !done)}
                emptyHint={emptyHint}
                heuristic={view.proposer === "heuristic"}
                className="h-[58svh] min-h-[380px] lg:order-1 lg:h-[min(74vh,740px)] lg:min-h-[520px]"
              />
            </div>

            <section className="mt-10" aria-labelledby="chart-h">
              <SectionHead id="chart-h" title="Evolution" note="Every experiment's CV score; the line is the best so far, with its noise band." />
              <EvolutionChart view={view} domainView={full} plannedExperiments={liveActive ? planned : totalExps} selectedId={selectedId} onSelect={setPinned} />
            </section>
            <LedgerAndDetail view={view} selectedId={selectedId} selected={selected} onSelect={setPinned} live={live} />
          </motion.div>
        ) : (
          <motion.div key="finished" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
            <div className="mt-6 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
              <div className="lg:sticky lg:top-4">
                <ReefPanel
                  statusText={endState ?? undefined}
                  view={view}
                  domainView={full}
                  selectedId={selectedId}
                  focusId={pinned}
                  onSelect={setPinned}
                  heightClass="h-[clamp(320px,52vh,520px)] lg:h-[clamp(480px,70vh,660px)]"
                />
              </div>
              <div className="space-y-6">
                <FinalScores view={view} />
                <StopReport view={view} />
              </div>
            </div>

            <LedgerAndDetail view={view} selectedId={selectedId} selected={selected} onSelect={setPinned} live={live} />

            <section className="mt-12" aria-labelledby="chart-h">
              <SectionHead id="chart-h" title="Evolution" note="Every experiment's CV score; the line is the best so far, with its noise band." />
              <EvolutionChart view={view} domainView={full} plannedExperiments={view.experiments.length} selectedId={selectedId} onSelect={setPinned} />
            </section>

            <div className="mt-12">
              <DataProfilePanel profile={view.profile ?? full?.profile ?? null} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function LedgerAndDetail({
  view,
  selectedId,
  selected,
  onSelect,
  live,
}: {
  view: View;
  selectedId: string | null;
  selected: View["experiments"][number] | null;
  onSelect: (id: string) => void;
  live: boolean;
}) {
  return (
    <div className="mt-12 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
      <Ledger view={view} selectedId={selectedId} onSelect={onSelect} />
      <div className="lg:sticky lg:top-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={selected?.id ?? "none"}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
          >
            <DetailPanel view={view} exp={selected} live={live} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function SectionHead({ id, title, note }: { id: string; title: string; note: string }) {
  return (
    <div className="mb-3">
      <h2 id={id} className="font-display text-2xl leading-none">
        {title}
      </h2>
      <p className="mt-1 text-xs text-ink-3">{note}</p>
    </div>
  );
}

function phaseLabel(v: View): string {
  if (v.phase === "finished") return "finished";
  if (v.phase === "stopped") return "scoring locked test";
  if (v.phase === "running") return v.current ? `running ${v.current.id}` : "deciding";
  return "starting";
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{label}</dt>
      <dd className={`font-mono tabular ${accent ? "text-best" : "text-ink"}`}>{value}</dd>
    </div>
  );
}

function SimulationBar(p: {
  cursor: number;
  total: number;
  expLabel: string | null;
  nExp: number;
  totalExp: number | null;
  playing: boolean;
  done: boolean;
  speed: Speed;
  onToggle: () => void;
  onSpeed: (s: Speed) => void;
  onRestart: () => void;
  onSkip: () => void;
  onExit: () => void;
}) {
  const pct = p.total ? (p.cursor / p.total) * 100 : 0;
  const ghost = "rounded-full px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink";
  return (
    <div className="relative mt-6 overflow-hidden rounded-xl border border-rule bg-paper-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 sm:px-4">
        <span className="flex items-center gap-2 text-sm">
          <span className={`size-2 rounded-full ${p.playing ? "animate-pulse bg-best" : p.done ? "bg-keep" : "bg-ink-3"}`} aria-hidden />
          <span className="font-medium">{p.done ? "Simulation complete" : p.playing ? "Simulating" : "Paused"}</span>
          <span className="font-mono text-xs text-ink-3 tabular">
            {p.expLabel ? `${p.expLabel} · ` : ""}
            {p.nExp}
            {p.totalExp ? ` / ${p.totalExp}` : ""} experiments
          </span>
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {p.done ? (
            <>
              <button className={ghost} onClick={p.onRestart}>
                Replay again
              </button>
              <button className="rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-paper" onClick={p.onExit}>
                See the results
              </button>
            </>
          ) : (
            <>
              <button
                onClick={p.onToggle}
                className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper transition-transform active:scale-95"
                aria-label={p.playing ? "Pause simulation" : "Resume simulation"}
              >
                {p.playing ? (
                  <svg viewBox="0 0 16 16" className="size-3" aria-hidden>
                    <rect x="4" y="3" width="3" height="10" fill="currentColor" />
                    <rect x="9" y="3" width="3" height="10" fill="currentColor" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" className="size-3" aria-hidden>
                    <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
                  </svg>
                )}
                {p.playing ? "Pause" : "Resume"}
              </button>
              <div className="flex rounded-full border border-rule p-0.5" role="group" aria-label="Simulation speed">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    onClick={() => p.onSpeed(s)}
                    aria-pressed={p.speed === s}
                    className={`rounded-full px-2 py-0.5 font-mono text-xs transition-colors ${p.speed === s ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"}`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
              <button className={ghost} onClick={p.onSkip}>
                Skip to end
              </button>
            </>
          )}
          <button className={`${ghost} inline-flex items-center gap-1`} onClick={p.onExit} aria-label="Exit simulation">
            <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="hidden sm:inline">Exit</span>
          </button>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-rule" aria-hidden>
        <div className="h-full origin-left bg-best transition-transform duration-500 ease-out" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
    </div>
  );
}
