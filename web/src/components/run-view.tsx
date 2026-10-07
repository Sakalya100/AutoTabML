"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AnyEvent, EventType } from "@/lib/events";
import { activeAgentStep, buildFeed } from "@/lib/feed";
import { formatScore } from "@/lib/metrics";
import { buildView, type RunView as View } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { proposerNote } from "@/lib/story";
import { EASE, MagneticLink } from "./landing/primitives";
import { Journey } from "./replay/journey";
import { RunStage, SimulateLink } from "./replay/stage";
import { TechnicalDetails } from "./replay/technical";
import { SurveyPanel } from "./survey-panel";
import { StepFeed } from "./step-feed";
import "./terra.css";
import "./replay/replay.css";

interface Props {
  mode: "replay" | "live";
  events: AnyEvent[];
  record: RunRecord | null;
  /** Plain name of the run ("Breast cancer", "Predicting variety"). */
  title: string;
  /** Small line above the title ("A recorded run"). */
  kicker?: string;
  /** Replaces the proposer note under the summary (e.g. "hand-written example"). */
  note?: ReactNode;
  /** Live mode: the run is still producing events (shows the feed + growing world). */
  active?: boolean;
  /** Live mode: status strip + cancel. */
  liveBar?: ReactNode;
  /** Live mode: what to say in the feed before the first event arrives. */
  emptyHint?: string;
  plannedExperiments?: number | null;
  /** Replay: open straight into the simulation (?simulate). */
  initialSimulate?: boolean;
  /** Live mode: a terminal status other than finished ("cancelled", "failed"). */
  endedAs?: string | null;
  /** Replay: the other recorded runs (the closing message links to them). */
  others?: { name: string }[];
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
  agent_step_started: 120,
  agent_reasoning: 30,
  agent_step_finished: 220,
  sandbox_log: 30,
  hpo_trial: 30,
  report_ready: 900,
};
const FIRST_STEP_DELAY = 1500; // let the reader take in the "run started" message
const SPEEDS = [1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

export function RunView({ mode, events, record, title, kicker, note, active, liveBar, emptyHint, plannedExperiments, initialSimulate, endedAs, others }: Props) {
  const live = mode === "live";
  const [simulating, setSimulating] = useState(!!initialSimulate && events.length > 0);
  const [cursor, setCursor] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<Speed>(1);
  const [pinned, setPinned] = useState<string | null>(null);
  const [reveal, setReveal] = useState(0);

  const liveActive = live && !!active;
  // When a live run finishes, hold the feed + world a few seconds so the locked-test moment plays out.
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
  // The complete run fixes the world's and the chart's scales, so a simulation grows without rescaling.
  const full = useMemo(() => (liveActive ? null : buildView(events, record)), [liveActive, events, record]);
  const items = useMemo(() => (staging ? buildFeed(shownEvents) : []), [staging, shownEvents]);
  const activity = useMemo(() => (staging ? activeAgentStep(shownEvents) : null), [staging, shownEvents]);

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
  const scrollTop = () => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" }));
  };

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

  const stopRule = (view.config.stop_rule ?? {}) as Record<string, unknown>;
  const cfgMax = view.config.max_experiments ?? stopRule.max_experiments;
  const planned = plannedExperiments ?? (typeof cfgMax === "number" ? cfgMax : null);
  const totalExps = full?.experiments.length ?? null;

  const details = (
    <TechnicalDetails
      view={view}
      domainView={full}
      plannedExperiments={view.experiments.length}
      selectedId={selectedId}
      onSelect={setPinned}
      live={live}
      reveal={reveal}
    />
  );

  return (
    <div data-terra className="rp-root">
      <div ref={top} />
      <AnimatePresence mode="wait" initial={false}>
        {staging ? (
          <motion.div key="stage" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ duration: 0.45, ease: EASE }}>
            <RunBar
              title={title}
              kicker={simulating ? "Replaying a recorded run" : live ? "Live run" : kicker}
              view={view}
              total={liveActive ? planned : totalExps}
              note={live ? null : proposerNote(view.proposer)}
              controls={
                simulating ? (
                  <SimulationControls
                    playing={playing && !done}
                    done={done}
                    speed={speed}
                    onToggle={() => setPlaying((p) => !p)}
                    onSpeed={setSpeed}
                    onRestart={startSimulation}
                    onExit={exitSimulation}
                  />
                ) : null
              }
              progress={simulating ? shown / Math.max(1, events.length) : null}
            />
            {liveBar && <div className="rp-livebar">{liveBar}</div>}
            <div className="rp-live">
              <div className="rp-live-world">
                <SurveyPanel
                  statusText={endState ?? undefined}
                  view={view}
                  domainView={full}
                  selectedId={selectedId}
                  onSelect={setPinned}
                  staging
                  compact
                  bare
                  heightClass="h-full"
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
                activity={activity}
                className="rp-live-feed"
              />
            </div>
            <TechnicalDetails
              view={view}
              domainView={full}
              plannedExperiments={liveActive ? planned : totalExps}
              selectedId={selectedId}
              onSelect={setPinned}
              live={live}
              defaultOpen={["chart"]}
            />
          </motion.div>
        ) : (
          <motion.div key="finished" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, ease: EASE }}>
            {liveBar && <div className="rp-livebar">{liveBar}</div>}
            {!live && view.experiments.length > 0 ? (
              // A recorded run: the scroll journey, with the full record at its end.
              <Journey
                view={view}
                name={title}
                kicker={kicker}
                note={note}
                others={others}
                onDetails={(id) => {
                  setPinned(id);
                  setReveal((r) => r + 1);
                }}
                action={events.length > 0 ? <SimulateLink onClick={startSimulation}>Watch it run</SimulateLink> : null}
              >
                {details}
              </Journey>
            ) : (
              <>
                {view.experiments.length > 0 ? (
                  <RunStage
                    view={view}
                    name={title}
                    kicker={endState ? `${kicker ?? "Run"} · ${endState}` : kicker}
                    note={note}
                    focusId={pinned}
                    onSelect={setPinned}
                    onDetails={() => setReveal((r) => r + 1)}
                    action={events.length > 0 ? <SimulateLink onClick={startSimulation}>{live ? "Replay it" : "Watch it run"}</SimulateLink> : null}
                    secondary={
                      <MagneticLink href="/new" variant="ghost">
                        {live ? "Start another run" : "Try your own data"}
                      </MagneticLink>
                    }
                  />
                ) : (
                  <div className="rp-wrap rp-empty">
                    <p className="rp-kicker">{kicker}</p>
                    <h1 className="rp-h1">{title}</h1>
                    <p className="lp-sub">{endState ? `This run was ${endState} before it tried any ideas.` : "No ideas were recorded for this run."}</p>
                  </div>
                )}
                {details}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Staging header: the run's name, one plain status line, and the playback controls. */
function RunBar({ title, kicker, view, total, note, controls, progress }: { title: string; kicker?: string; view: View; total: number | null; note: string | null; controls: ReactNode; progress: number | null }) {
  const decided = view.experiments.filter((x) => x.status !== "running");
  const kept = decided.filter((x) => x.status === "keep").length;
  const best = view.experiments.find((x) => x.id === view.bestId);
  const status =
    view.phase === "finished"
      ? "Finished: the final test is open"
      : view.phase === "stopped"
        ? "Stopped. Running the one final test…"
        : view.current
          ? `Testing idea ${view.current.index + 1}${total ? ` of ${total}` : ""}`
          : view.phase === "running"
            ? "Choosing the next idea"
            : "Starting";
  return (
    <header className="rp-bar">
      <div className="rp-bar-row">
        <div className="min-w-0">
          {kicker && <p className="rp-kicker">{kicker}</p>}
          <h1 className="rp-bar-title">{title}</h1>
        </div>
        {controls}
      </div>
      <div className="rp-bar-row rp-bar-facts">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p key={status} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={{ duration: 0.22, ease: EASE }} className="rp-bar-status">
            {status}
          </motion.p>
        </AnimatePresence>
        <p className="rp-bar-nums">
          <span>
            <b>{decided.length}</b> tried
          </span>
          <span>
            <b className="rp-signal">{kept}</b> kept
          </span>
          <span>
            best <b className="rp-signal">{best?.cv ? formatScore(view.metric, best.cv.mean) : "—"}</b>
          </span>
          {note && <span className="rp-bar-note">{note}</span>}
        </p>
      </div>
      {progress != null && (
        <div className="rp-bar-progress" aria-hidden>
          <div style={{ transform: `scaleX(${progress})` }} />
        </div>
      )}
    </header>
  );
}

function SimulationControls(p: {
  playing: boolean;
  done: boolean;
  speed: Speed;
  onToggle: () => void;
  onSpeed: (s: Speed) => void;
  onRestart: () => void;
  onExit: () => void;
}) {
  return (
    <div className="rp-controls">
      {p.done ? (
        <>
          <button type="button" className="rp-ctl" onClick={p.onRestart}>
            Watch again
          </button>
          <button type="button" className="rp-ctl rp-ctl-primary" onClick={p.onExit}>
            See the result <span aria-hidden>→</span>
          </button>
        </>
      ) : (
        <>
          <button type="button" className="rp-ctl rp-ctl-primary" onClick={p.onToggle} aria-label={p.playing ? "Pause" : "Resume"}>
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
          <div className="rp-speeds" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} type="button" onClick={() => p.onSpeed(s)} aria-pressed={p.speed === s}>
                {s}×
              </button>
            ))}
          </div>
          <button type="button" className="rp-ctl" onClick={p.onExit}>
            Skip to the result
          </button>
        </>
      )}
    </div>
  );
}
