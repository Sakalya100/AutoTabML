"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AnyEvent } from "@/lib/events";
import { formatScore } from "@/lib/metrics";
import { buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { EvolutionChart } from "./evolution-chart";

/** A silent, looping mini-replay for the landing page. The full, scrubbable version lives at /replays/<name>. */
export function HeroReplay({ name, events, record }: { name: string; events: AnyEvent[]; record: RunRecord }) {
  const [n, setN] = useState(1);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      const t = setTimeout(() => setN(events.length), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setN((c) => (c >= events.length ? 1 : c + 1)), n >= events.length ? 4200 : events[n]?.type === "decision" ? 380 : 140);
    return () => clearTimeout(t);
  }, [n, events]);
  const full = useMemo(() => buildView(events, record), [events, record]);
  const view = useMemo(() => buildView(events.slice(0, n), record), [events, n, record]);
  const latest = [...view.experiments].reverse().find((x) => x.status !== "running") ?? null;
  return (
    <Link href={`/replays/${name}`} className="group block" aria-label="Open the full replay">
      <EvolutionChart view={view} domainView={full} plannedExperiments={full.experiments.length} compact />
      <div className="mt-2 flex min-h-[2.5rem] items-start justify-between gap-4 text-xs">
        <span className="text-ink-2">
          {latest ? (
            <>
              <span className="font-mono text-ink-3">{latest.id}</span> {latest.idea.title} —{" "}
              <span className={latest.status === "keep" ? "text-keep" : latest.status === "crash" ? "text-crash" : "text-ink-3"}>{latest.status}</span>
            </>
          ) : (
            "profiling the data…"
          )}
        </span>
        <span className="shrink-0 font-mono text-ink-3 tabular">
          {view.final ? `test ${formatScore(view.metric, view.final.testScore)}` : view.stop ? "stop rule fired" : `${view.experiments.length} exp`}
        </span>
      </div>
    </Link>
  );
}
