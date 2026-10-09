"use client";

import { useState } from "react";
import { fmtCost, fmtDuration, fmtInt } from "@/lib/format";
import { fmtNum, formatScore, formatSe, scoreDelta, toRaw } from "@/lib/metrics";
import { parentOf, type ExpView, type RunView } from "@/lib/run-state";
import { plainGateReason } from "@/lib/verdict";
import { CategoryChip, RadicalBadge, StatusBadge } from "./badges";
import { CodeView, DiffView } from "./code-view";

type Tab = "overview" | "diff" | "code" | "error" | "llm";

export function DetailPanel({ view, exp, live }: { view: RunView; exp: ExpView | null; live?: boolean }) {
  const [tab, setTab] = useState<Tab>("overview");
  if (!exp)
    return (
      <aside className="rounded-md border border-dashed border-rule-strong p-6 text-sm text-ink-3">
        Select an experiment in the chart or the list to see its idea, the gate&apos;s decision, and the code change.
      </aside>
    );

  const parent = parentOf(view, exp);
  const lastFail = [...exp.attempts].reverse().find((a) => !a.ok);
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "overview", label: "Overview", show: true },
    { id: "diff", label: "Diff", show: true },
    { id: "code", label: "Code", show: true },
    { id: "error", label: "Error", show: !!lastFail },
    { id: "llm", label: `LLM calls${exp.llmCalls.length ? ` (${exp.llmCalls.length})` : ""}`, show: true },
  ];
  const active = tabs.find((t) => t.id === tab && t.show) ? tab : "overview";
  const noCode = (
    <p className="text-sm text-ink-3">
      {live ? "Code and diffs arrive with the run record when the run finishes." : "This run record has no code for this experiment."}
    </p>
  );

  return (
    <aside className="rounded-md border border-rule bg-paper" aria-label={`Experiment ${exp.id}`}>
      <div className="border-b border-rule px-4 pt-4 pb-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono text-ink-2">{exp.id}</span>
          <span className="text-ink-3">{parent ? `branched from ${parent.id}` : "root"}</span>
          <span className="ml-auto flex items-center gap-2">
            <CategoryChip category={exp.idea.category} />
            {exp.idea.radical && <RadicalBadge />}
            <StatusBadge status={exp.status} />
          </span>
        </div>
        <h3 className="mt-2 font-display text-[1.45rem] leading-tight">{exp.idea.title}</h3>
      </div>
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-rule px-2 text-sm">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={active === t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-2.5 py-2 whitespace-nowrap transition-colors ${
                active === t.id ? "border-best text-ink" : "border-transparent text-ink-3 hover:text-ink"
              } ${t.id === "error" ? "text-crash" : ""}`}
            >
              {t.label}
            </button>
          ))}
      </div>
      <div className="p-4">
        {active === "overview" && <Overview view={view} exp={exp} parent={parent} />}
        {active === "diff" && (exp.diff !== undefined ? <DiffView diff={exp.diff} /> : noCode)}
        {active === "code" && (exp.code ? <CodeView code={exp.code} /> : noCode)}
        {active === "error" && lastFail && (
          <div className="space-y-3">
            <p className="text-sm text-ink-2">
              <span className="font-medium text-crash">{lastFail.errorKind ?? "error"}</span> on attempt {lastFail.attempt + 1} of {exp.attempts.length}
              {exp.attempts.length > 1 && " (attempts after the first are automatic repairs)"}. This is the tail the agent saw.
            </p>
            <pre className="max-h-[420px] overflow-auto rounded-md border border-crash/30 bg-[var(--del-bg)] p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">
              {lastFail.errorTail ?? "(no output captured)"}
            </pre>
          </div>
        )}
        {active === "llm" && <LlmCalls exp={exp} proposer={view.proposer} />}
      </div>
    </aside>
  );
}

function Overview({ view, exp, parent }: { view: RunView; exp: ExpView; parent: ExpView | null }) {
  const d = scoreDelta(view.metric, parent?.cv?.mean, exp.cv?.mean);
  return (
    <div className="space-y-5">
      {exp.idea.rationale && (
        <div>
          <Label>Rationale</Label>
          <p className="text-[15px] leading-relaxed text-ink">{exp.idea.rationale}</p>
        </div>
      )}
      <div>
        <Label>Gate decision</Label>
        <p className={`text-sm leading-relaxed ${exp.status === "running" ? "text-ink-3" : "text-ink"}`}>
          {exp.status === "running" ? "Waiting for the sandbox…" : exp.reason ? plainGateReason(exp.reason, exp.status, view.metric) : "(no reason recorded)"}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
        <Stat label="CV mean ± SE" value={exp.cv ? `${formatScore(view.metric, exp.cv.mean)} ± ${formatSe(exp.cv.se)}` : "—"} />
        <Stat label="Δ vs parent" value={d ? d.text : "—"} tone={d?.better ? "good" : undefined} />
        <Stat label="Select holdout" value={formatScore(view.metric, exp.selectScore)} />
        <Stat label="Fit time" value={fmtDuration(exp.fitTimeS)} />
        <Stat label="Lines of code" value={exp.loc != null ? String(exp.loc) : "—"} />
        <Stat label="Wall time" value={fmtDuration(exp.durationS)} />
      </dl>
      {exp.cv && exp.cv.folds.length > 0 && <Folds view={view} exp={exp} parent={parent} />}
    </div>
  );
}

/** Per-fold scores, paired with the parent's folds (same split order), which is what the gate's paired test sees. */
function Folds({ view, exp, parent }: { view: RunView; exp: ExpView; parent: ExpView | null }) {
  const f = exp.cv!.folds.map((v) => toRaw(view.metric, v));
  const p = parent?.cv?.folds.length === exp.cv!.folds.length ? parent.cv!.folds.map((v) => toRaw(view.metric, v)) : null;
  const all = [...f, ...(p ?? [])];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const W = 100;
  const pos = (v: number) => (hi === lo ? 50 : ((v - lo) / (hi - lo)) * W);
  return (
    <div>
      <Label>
        Fold scores ({f.length}){p && <span className="normal-case tracking-normal text-ink-3"> · paired with {parent!.id}</span>}
      </Label>
      <div className="space-y-1.5">
        {f.map((v, i) => (
          <div key={i} className="relative h-3">
            <div className="absolute inset-x-0 top-1/2 border-t border-rule" />
            {p && (
              <>
                <div
                  className="absolute top-1/2 h-px bg-ink-3"
                  style={{ left: `${Math.min(pos(v), pos(p[i]))}%`, width: `${Math.abs(pos(v) - pos(p[i]))}%` }}
                />
                <div
                  className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-discard bg-paper"
                  style={{ left: `${pos(p[i])}%` }}
                />
              </>
            )}
            <div
              className={`absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${exp.status === "keep" ? "bg-keep" : "bg-ink-2"}`}
              style={{ left: `${pos(v)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-3 tabular">
        <span>{fmtNum(lo)}</span>
        <span>{fmtNum(hi)}</span>
      </div>
    </div>
  );
}

function LlmCalls({ exp, proposer }: { exp: ExpView; proposer: string | null }) {
  if (!exp.llmCalls.length)
    return (
      <p className="text-sm text-ink-3">
        {proposer === "heuristic" ? "No LLM calls — this run used the offline heuristic proposer." : "No LLM calls recorded for this experiment."}
      </p>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
            <th className="py-1 pr-2 font-medium">purpose</th>
            <th className="py-1 pr-2 font-medium">model</th>
            <th className="py-1 pr-2 text-right font-medium">in / out tokens</th>
            <th className="py-1 pr-2 text-right font-medium">cost</th>
            <th className="py-1 text-right font-medium">latency</th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs tabular">
          {exp.llmCalls.map((c, i) => (
            <tr key={i} className="border-t border-rule">
              <td className="py-1.5 pr-2 font-sans">{c.purpose}</td>
              <td className="py-1.5 pr-2">{c.model}</td>
              <td className="py-1.5 pr-2 text-right">
                {fmtInt(c.input_tokens)} / {fmtInt(c.output_tokens)}
              </td>
              <td className="py-1.5 pr-2 text-right">{fmtCost(c.cost_usd)}</td>
              <td className="py-1.5 text-right">{fmtDuration(c.latency_s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-ink-3">{children}</div>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
  return (
    <div>
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className={`font-mono text-[13px] tabular ${tone === "good" ? "text-keep" : "text-ink"}`}>{value}</dd>
    </div>
  );
}
