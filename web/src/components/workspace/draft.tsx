"use client";

/**
 * The paste-a-link flow (Phase 2) as a chat turn: the composer hands a link (or a CSV file) and an optional sentence
 * to `useRunDraft`, which previews it and proposes target / problem type / metric. `DraftCard` renders the result as
 * the agent's reply: the run as one editable sentence, a peek at the table, and Start.
 */
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import { parseTable, type ColumnKind, type ColumnStats } from "@/lib/ingest/csv";
import type { Preview } from "@/lib/api-types";
import { METRIC_LABEL, PROBLEM_LABEL, suggest, suggestionFor, VALID_METRICS, type MetricId, type ProblemType, type Suggestion } from "@/lib/ingest/suggest";
import { DEFAULT_EXPERIMENTS, MAX_UPLOAD_BYTES, validateRunRequest, validateUrlRunRequest } from "@/lib/upload";

const EASE = [0.22, 1, 0.36, 1] as const;
const HEAD_BYTES = 2 * 1024 * 1024;
const SHOWN_ROWS = 5;

export interface DraftTable {
  label: string;
  columns: string[];
  stats: ColumnStats[];
  sample: string[][];
  rows: number | null;
  rowsExact: boolean;
  rewritten: boolean;
}

export interface Chips {
  target: string;
  problemType: ProblemType;
  metric: MetricId;
}

export type DraftStatus = "idle" | "loading" | "ready" | "error";

export interface DraftState {
  status: DraftStatus;
  source: { kind: "link"; url: string } | { kind: "file"; file: File; head: string } | null;
  goal: string;
  table: DraftTable | null;
  chips: Chips | null;
  touched: boolean;
  why: { text: string; source: Suggestion["source"] } | null;
  goalPlain: string | null;
  experiments: number;
  error: string | null;
  starting: boolean;
  startError: string | null;
}

const KIND_LABEL: Record<ColumnKind, string> = {
  numeric: "num",
  integer: "int",
  boolean: "bool",
  categorical: "cat",
  text: "text",
  datetime: "date",
  id: "id",
  empty: "empty",
};

/** "titanic.csv" for a link to a file, else the host. */
const fileOf = (u: string) => {
  try {
    const last = decodeURIComponent(new URL(u).pathname.split("/").filter(Boolean).at(-1) ?? "");
    return /\.(csv|tsv|txt|parquet)$/i.test(last) ? last : hostOf(u);
  } catch {
    return hostOf(u);
  }
};

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** "Predict Survived (yes / no), scored by ROC AUC, over at most 8 experiments." — the run as the user confirmed it. */
export function runSentence(chips: Chips, experiments: number, label: string): string {
  return `Predict ${chips.target} (${PROBLEM_LABEL[chips.problemType]}) in ${label}, scored by ${METRIC_LABEL[chips.metric]}, over at most ${experiments} experiments.`;
}

export function useRunDraft(maxExperiments: number) {
  const reduced = useReducedMotion();
  const [s, setS] = useState<DraftState>({
    status: "idle",
    source: null,
    goal: "",
    table: null,
    chips: null,
    touched: false,
    why: null,
    goalPlain: null,
    experiments: Math.min(DEFAULT_EXPERIMENTS, maxExperiments),
    error: null,
    starting: false,
    startError: null,
  });
  const reqId = useRef(0);
  const ctrl = useRef<AbortController | null>(null);
  const touched = useRef(false);

  const apply = useCallback((sug: Suggestion | null) => {
    if (!sug) return;
    setS((p) => ({
      ...p,
      why: { text: sug.why, source: sug.source },
      goalPlain: sug.goalPlain,
      chips: touched.current && p.chips ? p.chips : { target: sug.target, problemType: sug.problemType, metric: sug.metric },
    }));
  }, []);

  /** Preview a public link (the server fetches it with SSRF guards and suggests the chips). */
  const previewLink = useCallback(
    async (url: string, goal: string) => {
      const id = ++reqId.current;
      ctrl.current?.abort();
      const ac = new AbortController();
      ctrl.current = ac;
      touched.current = false;
      setS((p) => ({
        ...p,
        status: "loading",
        source: { kind: "link", url },
        goal,
        table: null,
        chips: null,
        touched: false,
        why: null,
        goalPlain: null,
        error: null,
        startError: null,
      }));
      try {
        const res = await fetch("/api/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, goal }),
          signal: ac.signal,
        });
        const body = (await res.json()) as { preview?: Preview; suggestion?: Suggestion | null; error?: string };
        if (id !== reqId.current) return;
        if (!res.ok || !body.preview) {
          setS((p) => ({ ...p, status: "error", error: body.error ?? "Couldn't read that link." }));
          return;
        }
        const pv = body.preview;
        setS((p) => ({
          ...p,
          status: "ready",
          table: {
            label: fileOf(pv.finalUrl) || "link",
            columns: pv.columns,
            stats: pv.stats,
            sample: pv.sample,
            rows: pv.rows,
            rowsExact: pv.rowsExact,
            rewritten: pv.rewritten,
          },
        }));
        apply(body.suggestion ?? suggest(pv.stats, goal));
      } catch (e) {
        if ((e as Error).name === "AbortError" || id !== reqId.current) return;
        setS((p) => ({ ...p, status: "error", error: "Couldn't reach the server. Check your connection and try again." }));
      }
    },
    [apply],
  );

  /** A local CSV: parsed in the browser, chips from the same rules of thumb (nothing is uploaded until Start). */
  const previewFile = useCallback(
    async (file: File, goal: string) => {
      ++reqId.current;
      ctrl.current?.abort();
      touched.current = false;
      if (file.size > MAX_UPLOAD_BYTES) {
        setS((p) => ({
          ...p,
          status: "error",
          source: null,
          table: null,
          chips: null,
          error: `The file is ${(file.size / 1048576).toFixed(1)} MB; uploads are limited to 5 MB. Paste a link instead (up to 50 MB).`,
        }));
        return;
      }
      const head = await file.slice(0, HEAD_BYTES).text();
      const partial = file.size > HEAD_BYTES;
      const parsed = parseTable(head, { partial, sampleRows: 50 });
      if (parsed.columns.length < 2) {
        setS((p) => ({
          ...p,
          status: "error",
          source: null,
          table: null,
          chips: null,
          error: "We couldn't find at least two columns. Is this a CSV with a header row?",
        }));
        return;
      }
      setS((p) => ({
        ...p,
        status: "ready",
        source: { kind: "file", file, head },
        goal,
        touched: false,
        error: null,
        startError: null,
        table: {
          label: file.name,
          columns: parsed.columns,
          stats: parsed.stats,
          sample: parsed.sample,
          rows: parsed.parsedRows,
          rowsExact: !partial,
          rewritten: false,
        },
      }));
      apply(suggest(parsed.stats, goal));
    },
    [apply],
  );

  const setTarget = (target: string) => {
    if (!s.table) return;
    const sug = suggestionFor(s.table.stats, target, "your pick");
    touched.current = true;
    setS((p) => ({ ...p, touched: true, chips: { target, problemType: sug.problemType, metric: sug.metric }, goalPlain: sug.goalPlain, why: null }));
  };
  const setMetric = (metric: MetricId) => {
    touched.current = true;
    setS((p) => ({ ...p, touched: true, chips: p.chips ? { ...p.chips, metric } : p.chips }));
  };
  const setExperiments = (n: number) => setS((p) => ({ ...p, experiments: n }));
  const clear = () => {
    ++reqId.current;
    ctrl.current?.abort();
    setS((p) => ({ ...p, status: "idle", source: null, table: null, chips: null, error: null, startError: null }));
  };

  /** POST /api/runs; resolves to {id, sessionId} or null (the error is on the state). */
  const start = async (sessionId: string | null): Promise<{ id: string; sessionId: string | null } | null> => {
    if (s.status !== "ready" || !s.chips || !s.table || !s.source || s.starting) return null;
    const { chips, experiments, goal } = s;
    const sentence = runSentence(chips, experiments, s.table.label);
    let init: RequestInit;
    if (s.source.kind === "link") {
      const v = validateUrlRunRequest({ url: s.source.url, target: chips.target, metric: chips.metric, goal, maxExperiments: experiments }, { maxExperiments });
      if (!v.ok) {
        setS((p) => ({ ...p, startError: v.error }));
        return null;
      }
      init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: s.source.url,
          target: chips.target,
          metric: chips.metric,
          goal: goal.trim(),
          maxExperiments: experiments,
          sessionId,
          sentence,
        }),
      };
    } else {
      const f = s.source.file;
      const v = validateRunRequest(
        {
          fileName: f.name,
          fileBytes: f.size,
          head: s.source.head,
          complete: f.size <= HEAD_BYTES,
          target: chips.target,
          metric: chips.metric,
          goal,
          maxExperiments: experiments,
        },
        { maxExperiments },
      );
      if (!v.ok) {
        setS((p) => ({ ...p, startError: v.error }));
        return null;
      }
      const fd = new FormData();
      fd.set("file", f);
      fd.set("target", chips.target);
      fd.set("metric", chips.metric);
      fd.set("goal", goal.trim());
      fd.set("maxExperiments", String(experiments));
      fd.set("sentence", sentence);
      if (sessionId) fd.set("sessionId", sessionId);
      init = { method: "POST", body: fd };
    }
    setS((p) => ({ ...p, starting: true, startError: null }));
    try {
      const res = await fetch("/api/runs", init);
      const body = (await res.json()) as { id?: string; sessionId?: string | null; error?: string };
      if (!res.ok || !body.id) {
        setS((p) => ({ ...p, starting: false, startError: body.error ?? "Something went wrong starting the run." }));
        return null;
      }
      return { id: body.id, sessionId: body.sessionId ?? null };
    } catch {
      setS((p) => ({ ...p, starting: false, startError: "Couldn't reach the server. Check your connection and try again." }));
      return null;
    }
  };

  const done = () => {
    ++reqId.current;
    setS((p) => ({ ...p, status: "idle", source: null, table: null, chips: null, starting: false }));
  };

  return { state: s, previewLink, previewFile, setTarget, setMetric, setExperiments, clear, start, done, reduced, maxExperiments };
}

export type RunDraft = ReturnType<typeof useRunDraft>;

/** The agent's reply to a pasted link: what it read, the run as one editable sentence, and Start. */
export function DraftCard({ draft, onStart }: { draft: RunDraft; onStart: () => void }) {
  const { state: s, reduced } = draft;
  if (s.status === "idle") return null;
  if (s.status === "loading")
    return (
      <div className="ws-agent" aria-live="polite">
        <p className="ws-role">Intake</p>
        <p className="ws-plain text-[var(--lp-ink-2)]">Reading {s.source?.kind === "link" ? hostOf(s.source.url) || "the link" : "your file"}…</p>
        <div className="nr-scan mt-3 max-w-[18rem]" aria-hidden />
      </div>
    );
  if (s.status === "error")
    return (
      <div className="ws-agent" role="alert">
        <p className="ws-role ws-role-crash">Intake</p>
        <p className="ws-plain text-[var(--crash)]">{s.error}</p>
        <p className="mt-1 text-[13px] text-[var(--lp-ink-3)]">Paste another link, or attach a CSV instead.</p>
      </div>
    );
  const { table, chips } = s;
  if (!table || !chips) return null;
  const statBy = new Map(table.stats.map((x) => [x.name, x]));
  return (
    <motion.div
      className="ws-agent"
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: EASE }}
    >
      <p className="ws-role">Intake</p>
      <p className="font-mono text-[11.5px] text-[var(--lp-ink-3)] tabular-nums">
        <span className="text-[var(--lp-ink-2)]">{table.label}</span> ·{" "}
        {table.rows == null ? "rows: unknown" : `${table.rowsExact ? "" : "≈ "}${table.rows.toLocaleString("en-US")} rows`} · {table.columns.length} columns
        {table.rewritten && " · share link → direct download"}
      </p>
      <div className="ws-sentence mt-3">
        Predict{" "}
        <span className="nr-chip">
          <select aria-label="Column to predict" value={chips.target} onChange={(e) => draft.setTarget(e.target.value)}>
            {table.columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </span>
        , as <span className="text-[var(--lp-ink-2)] italic">{PROBLEM_LABEL[chips.problemType]}</span>, scored by{" "}
        <span className="nr-chip">
          <select aria-label="Metric" value={chips.metric} onChange={(e) => draft.setMetric(e.target.value as MetricId)}>
            {VALID_METRICS[chips.problemType].map((m) => (
              <option key={m} value={m}>
                {METRIC_LABEL[m]}
              </option>
            ))}
          </select>
        </span>
        , over at most{" "}
        <span className="nr-chip">
          <select
            aria-label="Experiments"
            value={s.experiments}
            onChange={(e) => draft.setExperiments(Number(e.target.value))}
            className="font-mono tabular-nums"
          >
            {Array.from({ length: draft.maxExperiments }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </span>{" "}
        experiments.
      </div>
      <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-[var(--lp-ink-3)]">
        {s.goalPlain}
        {!s.touched && s.why && <> Why: {s.why.text.replace(/\.$/, "")}.</>}{" "}
        <span className="font-mono text-[10.5px]">
          {s.touched ? "· your pick" : s.why?.source === "llm" ? "· suggested by gpt-oss" : "· suggested by rules of thumb"}
        </span>
      </p>
      <div className="mt-4 overflow-x-auto [mask-image:linear-gradient(to_right,#000_80%,transparent)]">
        <table className="nr-table font-mono text-[11.5px] text-[var(--lp-ink-2)] tabular-nums">
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c} data-target={c === chips.target ? "" : undefined} className="align-bottom font-normal">
                  <span className="block">{c}</span>
                  <span className="block text-[10px] text-[var(--lp-ink-3)]">{KIND_LABEL[statBy.get(c)?.kind ?? "text"]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.sample.slice(0, SHOWN_ROWS).map((r, i) => (
              <tr key={i}>
                {table.columns.map((c, j) => (
                  <td key={c} data-target={c === chips.target ? "" : undefined} title={r[j]}>
                    {r[j] === "" ? <span className="text-[var(--lp-ink-3)]">·</span> : r[j]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
        <button type="button" onClick={onStart} disabled={s.starting} className="ws-start">
          {s.starting ? "Starting…" : "Start"} <span aria-hidden>→</span>
        </button>
        <button type="button" onClick={draft.clear} disabled={s.starting} className="ws-link">
          Use different data
        </button>
      </div>
      {s.startError && (
        <p role="alert" className="mt-3 text-[14px] text-[var(--crash)]">
          {s.startError}
        </p>
      )}
      <p className="mt-4 text-[12px] text-[var(--lp-ink-3)]">Runs on free Groq and Gemini models; data rows are never sent to Gemini.</p>
    </motion.div>
  );
}
