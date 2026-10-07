"use client";

/*
 * The precise record behind the plain-language story: nothing technical is removed, it is moved behind progressive
 * disclosure. One row per question, closed by default; a row's content mounts the first time it opens.
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DataProfilePanel } from "@/components/data-profile";
import { DetailPanel } from "@/components/detail-panel";
import { EvolutionChart } from "@/components/evolution-chart";
import { Ledger } from "@/components/ledger";
import { FinalScores, StopReport } from "@/components/stop-report";
import { EASE } from "@/components/landing/primitives";
import { STOP_REASON_LABEL } from "@/lib/format";
import type { RunView } from "@/lib/run-state";
import { displayScore, plainIdea } from "@/lib/story";

type RowId = "idea" | "chart" | "ledger" | "stop" | "test" | "data";

interface Props {
  view: RunView;
  /** Complete run, for stable chart axes while a run grows. */
  domainView: RunView | null;
  plannedExperiments: number | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  live: boolean;
  /** Incremented to open "the selected idea" and bring it into view. */
  reveal?: number;
  defaultOpen?: RowId[];
}

export function TechnicalDetails({ view, domainView, plannedExperiments, selectedId, onSelect, live, reveal = 0, defaultOpen = [] }: Props) {
  const [open, setOpen] = useState<Set<RowId>>(() => new Set(defaultOpen));
  const root = useRef<HTMLElement>(null);
  const toggle = (id: RowId) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const [seenReveal, setSeenReveal] = useState(reveal);
  if (reveal !== seenReveal) {
    setSeenReveal(reveal);
    if (!open.has("idea")) setOpen((s) => new Set(s).add("idea"));
  }
  useEffect(() => {
    if (!reveal) return;
    const el = root.current?.querySelector<HTMLElement>('[data-row="idea"]');
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => el?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" }));
  }, [reveal]);

  const exp = view.experiments.find((x) => x.id === selectedId) ?? null;
  const best = view.experiments.find((x) => x.id === view.bestId);
  const kept = view.experiments.filter((x) => x.status === "keep").length;
  const signals = view.stop?.signals.filter((s) => s.fired != null) ?? [];
  const f = view.final;
  const m = view.metric;
  const p = view.profile ?? domainView?.profile ?? null;

  const rows: { id: RowId; title: string; summary: ReactNode; body: ReactNode; show: boolean }[] = [
    {
      id: "idea",
      title: "The selected idea",
      summary: exp ? (
        <>
          <span className="rp-mono">{exp.id}</span> · {plainIdea(exp.idea)}
        </>
      ) : (
        "Pick an idea on the map, the timeline or the list"
      ),
      body: <DetailPanel view={view} exp={exp} live={live} />,
      show: true,
    },
    {
      id: "chart",
      title: "Score, idea by idea",
      summary: best?.cv ? (
        <>
          best <span className="rp-mono rp-signal">{displayScore(m, best.cv.mean)}</span> at <span className="rp-mono">{best.id}</span>, cross-validated
        </>
      ) : (
        "No scores yet"
      ),
      body: <EvolutionChart view={view} domainView={domainView} plannedExperiments={plannedExperiments} selectedId={selectedId} onSelect={onSelect} />,
      show: true,
    },
    {
      id: "ledger",
      title: "Every idea",
      summary: `${view.experiments.length} tried · ${kept} kept · code, diffs and the gate's reasons`,
      body: <Ledger view={view} selectedId={selectedId} onSelect={onSelect} />,
      show: true,
    },
    {
      id: "stop",
      title: "Why it stopped",
      summary: view.stop
        ? `${STOP_REASON_LABEL[view.stop.reason] ?? view.stop.reason} · ${signals.filter((s) => s.fired).length} of ${signals.length} signals agreed`
        : "Still running: the four stop signals are checked after every idea",
      body: <StopReport view={view} />,
      show: true,
    },
    {
      id: "test",
      title: "The final test",
      summary: f ? (
        <>
          dev CV <span className="rp-mono">{displayScore(m, f.devCvMean)}</span> · select <span className="rp-mono">{displayScore(m, f.selectScore)}</span> · test{" "}
          <span className="rp-mono">{displayScore(m, f.testScore)}</span>
        </>
      ) : (
        "Locked until the run ends, then opened once"
      ),
      body: <FinalScores view={view} />,
      show: true,
    },
    {
      id: "data",
      title: "What it was shown",
      summary: p ? `${p.n_rows.toLocaleString("en-US")} rows · ${p.n_cols} columns · a profile and at most 5 sample rows` : "The data profile",
      body: <DataProfilePanel profile={p} />,
      show: !!p,
    },
  ];

  return (
    <section ref={root} className="rp-tx" aria-labelledby="rp-tx-h">
      <div className="rp-tx-intro">
        <p className="rp-kicker">For the curious</p>
        <h2 id="rp-tx-h" className="rp-tx-h">
          The full record
        </h2>
        <p className="rp-tx-sub">Every number the run recorded, exactly as measured.</p>
      </div>
      <ol className="rp-tx-rows">
        {rows
          .filter((r) => r.show)
          .map((r) => (
            <Row key={r.id} id={r.id} title={r.title} summary={r.summary} open={open.has(r.id)} onToggle={() => toggle(r.id)}>
              {r.body}
            </Row>
          ))}
      </ol>
    </section>
  );
}

function Row({ id, title, summary, open, onToggle, children }: { id: string; title: string; summary: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <li className="rp-tx-row" data-row={id} data-open={open ? "" : undefined}>
      <h3>
        <button type="button" className="rp-tx-toggle" aria-expanded={open} aria-controls={`rp-tx-${id}`} onClick={onToggle}>
          <span className="rp-tx-title">{title}</span>
          <span className="rp-tx-summary">{summary}</span>
          <span className="rp-tx-plus" aria-hidden />
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`rp-tx-${id}`}
            className="rp-tx-body"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.32, ease: EASE }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}
