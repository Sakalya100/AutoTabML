"use client";

/**
 * The paste-a-link flow (Phase 2) as a chat turn: the composer hands a link (or a CSV file) and an optional sentence
 * to `useRunDraft`, which previews it and proposes target / problem type / metric. `SetupPane` renders the result in
 * the chat pane before the chat starts: the choices as custom controls, a peek at the table, and Start.
 */
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useRef, useState, type CSSProperties } from "react";
import { parseTable, type ColumnKind, type ColumnStats } from "@/lib/ingest/csv";
import type { CsvFormat, Preview } from "@/lib/api-types";
import { estimateText, setupWarnings, targetBlock } from "@/lib/ingest/guards";
import {
  allowedSuggestion,
  METRIC_LABEL,
  PROBLEM_LABEL,
  suggest,
  suggestionFor,
  VALID_METRICS,
  type MetricId,
  type ProblemType,
  type Suggestion,
} from "@/lib/ingest/suggest";
import { DEFAULT_EXPERIMENTS, MAX_UPLOAD_BYTES, validateRunRequest, validateUrlRunRequest } from "@/lib/upload";
import { Listbox } from "./listbox";
import { ScrambleIn, useMagnet } from "./fx/motion";

const EASE = [0.16, 1, 0.3, 1] as const;
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
  /** `format`: how the preview parsed the link, sent with the run so the engine parses it the same way. */
  source: { kind: "link"; url: string; format?: CsvFormat } | { kind: "file"; file: File; head: string } | null;
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
    if (!sug) {
      // Every column is an ID, free text, constant or mostly empty: nothing here can be learned.
      setS((p) => ({
        ...p,
        status: "error",
        error: "None of the columns can be predicted: they are IDs, free text, constant or mostly empty.",
      }));
      return;
    }
    setS((p) => ({
      ...p,
      why: { text: sug.why, source: sug.source },
      goalPlain: sug.goalPlain,
      chips:
        touched.current && p.chips
          ? p.chips
          : {
              target: sug.target,
              problemType: sug.problemType,
              metric: sug.metric,
            },
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
        const body = (await res.json()) as {
          preview?: Preview;
          suggestion?: Suggestion | null;
          error?: string;
        };
        if (id !== reqId.current) return;
        if (!res.ok || !body.preview) {
          setS((p) => ({
            ...p,
            status: "error",
            error: body.error ?? "Couldn't read that link.",
          }));
          return;
        }
        const pv = body.preview;
        setS((p) => ({
          ...p,
          status: "ready",
          source: { kind: "link", url, format: { delimiter: pv.delimiter, encoding: pv.encoding, decimal: pv.decimal } },
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
        // A server/LLM pick that lands on a column that can't be learned (an ID, free text) is replaced.
        apply(allowedSuggestion(pv.stats, body.suggestion ?? null, goal));
      } catch (e) {
        if ((e as Error).name === "AbortError" || id !== reqId.current) return;
        setS((p) => ({
          ...p,
          status: "error",
          error: "Couldn't reach the server. Check your connection and try again.",
        }));
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
    if (!s.table || targetBlock(s.table.stats.find((c) => c.name === target))) return;
    const sug = suggestionFor(s.table.stats, target, "your pick");
    touched.current = true;
    setS((p) => ({
      ...p,
      touched: true,
      chips: { target, problemType: sug.problemType, metric: sug.metric },
      goalPlain: sug.goalPlain,
      why: null,
    }));
  };
  const setMetric = (metric: MetricId) => {
    touched.current = true;
    setS((p) => ({
      ...p,
      touched: true,
      chips: p.chips ? { ...p.chips, metric } : p.chips,
    }));
  };
  const setExperiments = (n: number) => setS((p) => ({ ...p, experiments: n }));
  /** The optional "what to predict" note: re-suggests locally (no refetch) unless the user already picked. */
  const setGoal = (goal: string) => {
    setS((p) => {
      if (touched.current || !p.table) return { ...p, goal };
      const sug = suggest(p.table.stats, goal);
      if (!sug) return { ...p, goal };
      return {
        ...p,
        goal,
        why: { text: sug.why, source: sug.source },
        goalPlain: sug.goalPlain,
        chips: {
          target: sug.target,
          problemType: sug.problemType,
          metric: sug.metric,
        },
      };
    });
  };
  const clear = () => {
    ++reqId.current;
    ctrl.current?.abort();
    setS((p) => ({
      ...p,
      status: "idle",
      source: null,
      table: null,
      chips: null,
      error: null,
      startError: null,
    }));
  };

  /** POST /api/runs; resolves to {id, sessionId} or null (the error is on the state). */
  const start = async (sessionId: string | null): Promise<{ id: string; sessionId: string | null } | null> => {
    if (s.status !== "ready" || !s.chips || !s.table || !s.source || s.starting) return null;
    const { chips, experiments, goal } = s;
    const blocked = targetBlock(s.table.stats.find((c) => c.name === chips.target));
    if (blocked) {
      setS((p) => ({ ...p, startError: `${chips.target} can't be predicted: ${blocked}.` }));
      return null;
    }
    const sentence = runSentence(chips, experiments, s.table.label);
    let init: RequestInit;
    if (s.source.kind === "link") {
      const v = validateUrlRunRequest(
        {
          url: s.source.url,
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
      init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: s.source.url,
          target: chips.target,
          metric: chips.metric,
          goal: goal.trim(),
          maxExperiments: experiments,
          csvFormat: s.source.format,
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
      const body = (await res.json()) as {
        id?: string;
        sessionId?: string | null;
        error?: string;
      };
      if (!res.ok || !body.id) {
        setS((p) => ({
          ...p,
          starting: false,
          startError: body.error ?? "Something went wrong starting the run.",
        }));
        return null;
      }
      return { id: body.id, sessionId: body.sessionId ?? null };
    } catch {
      setS((p) => ({
        ...p,
        starting: false,
        startError: "Couldn't reach the server. Check your connection and try again.",
      }));
      return null;
    }
  };

  const done = () => {
    ++reqId.current;
    setS((p) => ({
      ...p,
      status: "idle",
      source: null,
      table: null,
      chips: null,
      starting: false,
    }));
  };

  return {
    state: s,
    previewLink,
    previewFile,
    setTarget,
    setMetric,
    setExperiments,
    setGoal,
    clear,
    start,
    done,
    reduced,
    maxExperiments,
  };
}

export type RunDraft = ReturnType<typeof useRunDraft>;

const METRIC_HINT: Record<MetricId, string> = {
  roc_auc: "ranks yes / no fairly, even when one is rare",
  log_loss: "rewards confident, correct probabilities",
  accuracy: "share of rows predicted right",
  f1_macro: "weighs every class equally, rare ones too",
  rmse: "typical error; big misses cost more",
  mae: "average error; robust to outliers",
  r2: "share of the variation explained",
};

/**
 * Setting up a run, in the chat pane itself (before any chat exists): what it read, the three choices as custom
 * controls, a peek at the table, and Start. Start hands over to the chat; "Use different data" goes back.
 */
export function SetupPane({ draft, onStart }: { draft: RunDraft; onStart: () => void }) {
  const { state: s } = draft;
  const [goal, setGoalText] = useState(s.goal);
  const startRef = useRef<HTMLButtonElement>(null);
  useMagnet(startRef, { disabled: s.status !== "ready" || s.starting });
  if (s.status === "idle") return null;
  const from = s.source?.kind === "link" ? hostOf(s.source.url) || "the link" : "your file";

  if (s.status === "loading")
    return (
      <div className="su-pane su-loading" aria-live="polite">
        <p className="ws-kicker">New run · reading the data</p>
        <p className="su-title">Reading {from}…</p>
        <p className="su-sub">Checking the header, the column types and a sample of rows.</p>
        <div className="nr-scan mt-5 max-w-[22rem]" aria-hidden />
        <button type="button" onClick={draft.clear} className="ws-link mt-8 text-[14px]">
          Cancel
        </button>
      </div>
    );
  if (s.status === "error")
    return (
      <div className="su-pane su-error" role="alert">
        <p className="ws-kicker text-[var(--crash)]">New run · couldn’t read it</p>
        <p className="su-title">{s.source?.kind === "file" ? "That file can’t be used." : "That link didn’t work."}</p>
        <p className="su-sub text-[var(--lp-ink-2)]">{s.error}</p>
        <button type="button" onClick={draft.clear} className="ws-start mt-7">
          <span aria-hidden>←</span> {s.source?.kind === "file" ? "Use different data" : "Try another link"}
        </button>
      </div>
    );

  const { table, chips } = s;
  if (!table || !chips) return null;
  const statBy = new Map(table.stats.map((x) => [x.name, x]));
  const targets = table.columns.map((c) => ({
    value: c,
    label: c,
    hint: KIND_LABEL[statBy.get(c)?.kind ?? "text"],
    badge: !s.touched && c === chips.target ? "suggested" : undefined,
    disabled: targetBlock(statBy.get(c)) ?? undefined,
  }));
  const blocked = targetBlock(statBy.get(chips.target));
  const warnings = setupWarnings(table.stats, chips.target, table.rows, chips.problemType);
  const eta = estimateText(table.rows, table.columns.length, s.experiments);
  const metrics = VALID_METRICS[chips.problemType].map((m) => ({
    value: m,
    label: METRIC_LABEL[m],
    hint: METRIC_HINT[m],
  }));
  const counts = Array.from({ length: draft.maxExperiments }, (_, i) => i + 1);
  const commitGoal = () => {
    if (goal.trim() !== s.goal.trim()) draft.setGoal(goal.trim());
  };

  return (
    <div className="su-pane su-ready" data-starting={s.starting || undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="ws-kicker">New run · set it up</p>
        <button type="button" onClick={draft.clear} disabled={s.starting} className="ws-link text-[13px]">
          <span aria-hidden>←</span> Use different data
        </button>
      </div>
      <p className="su-title">
        <ScrambleIn text={table.label} chars="abcdefghijklmnopqrstuvwxyz0123456789._-" duration={1.1} />
      </p>
      <p className="su-meta">
        {table.rows == null ? "rows: unknown" : `${table.rowsExact ? "" : "≈ "}${table.rows.toLocaleString("en-US")} rows`} · {table.columns.length} columns
        {s.source?.kind === "link" && ` · from ${from}`}
        {table.rewritten && " · share link → direct download"}
      </p>

      <div className="su-form">
        <div className="su-field">
          <span className="su-label" id="su-target">
            What to predict
          </span>
          <div className="su-control">
            <Listbox label="Column to predict" value={chips.target} options={targets} onChange={draft.setTarget} disabled={s.starting} />
            <span className="su-aside">
              as <em>{PROBLEM_LABEL[chips.problemType]}</em>
            </span>
          </div>
        </div>
        <div className="su-field">
          <span className="su-label">Score by</span>
          <div className="su-control">
            <Listbox label="Metric" value={chips.metric} options={metrics} onChange={(m) => draft.setMetric(m)} disabled={s.starting} />
            <span className="su-aside">{METRIC_HINT[chips.metric]}</span>
          </div>
        </div>
        <div className="su-field">
          <span className="su-label" id="su-exps">
            Experiments
          </span>
          <div className="su-control">
            <div className="su-seg" role="radiogroup" aria-labelledby="su-exps">
              {counts.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={s.experiments === n}
                  className="su-seg-btn"
                  disabled={s.starting}
                  onClick={() => draft.setExperiments(n)}
                >
                  {s.experiments === n && <motion.span layoutId="su-seg-ink" className="su-seg-ink" aria-hidden transition={{ duration: 0.5, ease: EASE }} />}
                  <span className="relative">{n}</span>
                </button>
              ))}
            </div>
            <span className="su-aside">at most; it stops early once gains are noise</span>
          </div>
        </div>
        <div className="su-field">
          <label className="su-label" htmlFor="su-goal">
            Goal <span className="text-[var(--lp-ink-3)]">(optional)</span>
          </label>
          <div className="su-control">
            <input
              id="su-goal"
              className="su-input"
              value={goal}
              maxLength={300}
              disabled={s.starting}
              placeholder="e.g. who survived, in plain words"
              onChange={(e) => setGoalText(e.target.value)}
              onBlur={commitGoal}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitGoal();
              }}
            />
          </div>
        </div>
      </div>

      {(blocked || warnings.length > 0) && (
        <ul className="su-warns" aria-label="Before you start">
          {blocked && <li className="su-blocked">{`${chips.target} can't be predicted: ${blocked}.`}</li>}
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <p className="su-why">
        {s.goalPlain}
        {!s.touched && s.why && <> Why: {s.why.text.replace(/\.$/, "")}.</>}{" "}
        <span className="font-mono text-[12px] text-[var(--lp-ink-3)]">
          {s.touched ? "· your pick" : s.why?.source === "llm" ? "· suggested by gpt-oss" : "· suggested by rules of thumb"}
        </span>
      </p>

      <div className="su-table-wrap">
        <table className="nr-table su-table font-mono tabular-nums">
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c} data-target={c === chips.target ? "" : undefined} className="align-bottom font-normal">
                  <span className="block">{c}</span>
                  <span className="block text-[11px] text-[var(--lp-ink-3)]">{KIND_LABEL[statBy.get(c)?.kind ?? "text"]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.sample.slice(0, SHOWN_ROWS).map((r, i) => (
              <tr key={i} style={{ "--i": i } as CSSProperties}>
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

      <p className="mt-5 text-[13px] text-[var(--lp-ink-3)]">Runs on free Groq and Gemini models; data rows are never sent to Gemini.</p>
      <div className="su-actions">
        <button ref={startRef} type="button" onClick={onStart} disabled={s.starting || !!blocked} className="ws-start su-start">
          {s.starting ? "Starting…" : "Start the run"} <span aria-hidden>→</span>
        </button>
        <p className="text-[13.5px] leading-snug text-[var(--lp-ink-3)]">
          {s.startError ? (
            <span role="alert" className="text-[var(--crash)]">
              {s.startError}
            </span>
          ) : (
            <>
              {runSentence(chips, s.experiments, table.label).replace(` in ${table.label}`, "")}
              {eta && (
                <>
                  {" "}
                  <span className="su-eta" title="From the table's size and the number of experiments; includes starting the sandbox.">
                    {eta}
                  </span>
                </>
              )}
            </>
          )}
        </p>
      </div>
    </div>
  );
}
