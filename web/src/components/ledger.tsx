"use client";

import { useState } from "react";
import { fmtCost, fmtDuration } from "@/lib/format";
import { formatScore, formatSe, scoreDelta } from "@/lib/metrics";
import { parentOf, type ExpView, type RunView } from "@/lib/run-state";
import { CategoryChip, RadicalBadge, StatusBadge } from "./badges";

interface Props {
  view: RunView;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function Ledger({ view, selectedId, onSelect }: Props) {
  const [mode, setMode] = useState<"ledger" | "tree">("ledger");
  return (
    <section aria-labelledby="ledger-h">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 id="ledger-h" className="font-display text-2xl leading-none">
            Experiments
          </h2>
          <p className="mt-1 text-xs text-ink-3">Every idea is stated before it is coded. Select one to see why it was kept or thrown away.</p>
        </div>
        <div role="tablist" aria-label="Experiment layout" className="flex shrink-0 rounded-full border border-rule p-0.5 text-xs">
          {(["ledger", "tree"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-full px-3 py-1 capitalize transition-colors ${mode === m ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {view.experiments.length === 0 ? (
        <p className="rounded-md border border-dashed border-rule-strong px-4 py-8 text-center text-sm text-ink-3">
          The first experiment is always the unmodified baseline. It will appear here as soon as it starts.
        </p>
      ) : mode === "ledger" ? (
        <LedgerTable view={view} selectedId={selectedId} onSelect={onSelect} />
      ) : (
        <Tree view={view} selectedId={selectedId} onSelect={onSelect} />
      )}
    </section>
  );
}

function Delta({ view, e }: { view: RunView; e: ExpView }) {
  const p = parentOf(view, e);
  const d = scoreDelta(view.metric, p?.cv?.mean, e.cv?.mean);
  if (!d) return <span className="text-ink-3">—</span>;
  return <span className={d.better ? "text-keep" : "text-ink-3"}>{d.text}</span>;
}

function LedgerTable({ view, selectedId, onSelect }: Props) {
  return (
    <div className="overflow-x-auto rounded-md border border-rule">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-rule bg-paper-2 text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
            <th className="py-2 pr-2 pl-3 font-medium">id</th>
            <th className="px-2 py-2 font-medium">idea</th>
            <th className="px-2 py-2 font-medium">status</th>
            <th className="px-2 py-2 text-right font-medium">cv mean ± se</th>
            <th className="px-2 py-2 text-right font-medium whitespace-nowrap" title="Change in CV mean versus the parent experiment, in the metric's own units">
              Δ parent
            </th>
            <th className="px-2 py-2 text-right font-medium">cost</th>
            <th className="py-2 pr-3 pl-2 text-right font-medium">time</th>
          </tr>
        </thead>
        <tbody>
          {view.experiments.map((e) => {
            const sel = e.id === selectedId;
            const isBest = e.id === view.bestId;
            return (
              <tr
                key={e.id}
                onClick={() => onSelect(e.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelect(e.id);
                  }
                }}
                tabIndex={0}
                aria-selected={sel}
                className={`cursor-pointer border-b border-rule align-top transition-colors last:border-b-0 ${sel ? "bg-best-soft" : "hover:bg-paper-2"}`}
              >
                <td className="py-2.5 pr-2 pl-3 font-mono text-xs whitespace-nowrap">
                  <span className={isBest ? "font-semibold text-best" : "text-ink-2"}>{e.id}</span>
                  <div className="text-[10px] text-ink-3">{e.parentId ? `← ${e.parentId}` : "root"}</div>
                </td>
                <td className="px-2 py-2.5">
                  <div className="leading-snug text-ink">{e.idea.title}</div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <CategoryChip category={e.idea.category} />
                    {e.idea.radical && <RadicalBadge />}
                    {isBest && <span className="text-[11px] font-medium text-best">★ best</span>}
                  </div>
                </td>
                <td className="px-2 py-2.5">
                  <StatusBadge status={e.status} />
                </td>
                <td className="px-2 py-2.5 text-right font-mono text-xs whitespace-nowrap tabular">
                  {e.cv ? (
                    <>
                      {formatScore(view.metric, e.cv.mean)} <span className="text-ink-3">± {formatSe(e.cv.se)}</span>
                    </>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                <td className="px-2 py-2.5 text-right font-mono text-xs tabular">
                  <Delta view={view} e={e} />
                </td>
                <td className="px-2 py-2.5 text-right font-mono text-xs text-ink-2 tabular">{fmtCost(e.costUsd)}</td>
                <td className="py-2.5 pr-3 pl-2 text-right font-mono text-xs whitespace-nowrap text-ink-2 tabular">{fmtDuration(e.durationS)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Tree({ view, selectedId, onSelect }: Props) {
  const kids = new Map<string | null, ExpView[]>();
  for (const e of view.experiments) {
    const k = e.parentId && view.experiments.some((p) => p.id === e.parentId) ? e.parentId : null;
    kids.set(k, [...(kids.get(k) ?? []), e]);
  }
  const node = (e: ExpView): React.ReactNode => {
    const children = kids.get(e.id) ?? [];
    const dot =
      e.status === "keep" ? "bg-keep" : e.status === "crash" ? "bg-crash" : e.status === "running" ? "bg-best animate-pulse" : "border border-discard bg-paper";
    return (
      <li key={e.id} className="relative pl-5 before:absolute before:top-0 before:left-0 before:h-full before:border-l before:border-rule-strong last:before:h-[1.05rem] after:absolute after:top-[1.05rem] after:left-0 after:w-3.5 after:border-t after:border-rule-strong">
        <button
          onClick={() => onSelect(e.id)}
          className={`my-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition-colors ${
            e.id === selectedId ? "bg-best-soft" : "hover:bg-paper-2"
          }`}
        >
          <span className={`size-2.5 shrink-0 rounded-full ${dot}`} aria-hidden />
          <span className={`font-mono text-xs ${e.id === view.bestId ? "font-semibold text-best" : "text-ink-3"}`}>{e.id}</span>
          <span className={`truncate ${e.status === "discard" ? "text-ink-2" : "text-ink"}`}>{e.idea.title}</span>
          {e.idea.radical && <RadicalBadge />}
          <span className="ml-auto shrink-0 font-mono text-xs text-ink-3 tabular">{e.cv ? formatScore(view.metric, e.cv.mean) : e.status === "crash" ? "crash" : ""}</span>
        </button>
        {children.length > 0 && <ul>{children.map(node)}</ul>}
      </li>
    );
  };
  return (
    <div className="rounded-md border border-rule p-3">
      <ul className="-ml-5">{(kids.get(null) ?? []).map(node)}</ul>
      <p className="mt-2 text-xs text-ink-3">
        Hill-climbing: each idea branches from the best solution at the time it was proposed. Discarded branches end where they were tried.
      </p>
    </div>
  );
}
