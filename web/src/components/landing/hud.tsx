"use client";

import { AnimatePresence, motion } from "motion/react";
import { fmtCost } from "@/lib/format";
import { formatScore, metricInfo } from "@/lib/metrics";
import type { RunView } from "@/lib/run-state";
import { REEF } from "@/lib/scene/contract";
import { EASE, Ticker } from "./primitives";

/** Live instrument readout bound to the replay's current view. */
export function Hud({ view, total, compact = false }: { view: RunView; total: number; compact?: boolean }) {
  const metric = view.metric ?? "score";
  const best = view.experiments.find((x) => x.id === view.bestId) ?? null;
  const kept = view.experiments.filter((x) => x.status === "keep").length;
  const latest = [...view.experiments].reverse().find((x) => x.status !== "running") ?? null;
  const running = view.current;
  const digits = metricInfo(metric).digits;
  const phase =
    view.phase === "finished" ? "test opened" : view.phase === "stopped" ? "stopped at the ceiling" : view.phase === "running" ? (view.experiments.length ? "growing" : "profiling the data") : "waiting";

  return (
    <div className="lp-hud" role="status" aria-live="off">
      <div className="lp-hud-row">
        <Cell k="experiment">
          <Ticker value={view.experiments.length} format={(n) => String(Math.round(n)).padStart(2, "0")} />
          <span className="lp-hud-dim">/{total}</span>
        </Cell>
        <Cell k="kept">
          <span style={{ color: REEF.keep }}>
            <Ticker value={kept} format={(n) => String(Math.round(n))} />
          </span>
        </Cell>
        <Cell k={`best ${metricInfo(metric).label}`} wide>
          <span style={{ color: REEF.best }}>
            {best?.cv ? <Ticker value={best.cv.mean} format={(n) => formatScore(metric, n, digits)} /> : "—"}
          </span>
        </Cell>
        {!compact && (
          <Cell k="LLM cost">
            <span>{fmtCost(view.totalCostUsd)}</span>
          </Cell>
        )}
      </div>
      <div className="lp-hud-ticker">
        <span className="lp-hud-phase">
          <span className="lp-hud-dot" data-phase={view.phase} />
          {phase}
        </span>
        {!compact && (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={running?.id ?? latest?.id ?? "none"}
              className="min-w-0 truncate"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.35, ease: EASE }}
            >
              {running ? (
                <>
                  <span className="text-[color:var(--lp-ink-3)]">{running.id}</span> {running.idea.title}
                </>
              ) : latest ? (
                <>
                  <span className="text-[color:var(--lp-ink-3)]">{latest.id}</span> {latest.idea.title} ·{" "}
                  <span style={{ color: latest.status === "keep" ? REEF.keep : latest.status === "crash" ? REEF.crash : REEF.discard }}>
                    {latest.status === "discard" ? "withered" : latest.status === "keep" ? "kept" : latest.status}
                  </span>
                </>
              ) : null}
            </motion.span>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

function Cell({ k, children, wide = false }: { k: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "lp-hud-cell lp-hud-cell-wide" : "lp-hud-cell"}>
      <div className="lp-hud-k">{k}</div>
      <div className="lp-hud-v tabular">{children}</div>
    </div>
  );
}
