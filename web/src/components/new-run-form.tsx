"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseTable, type ColumnKind, type ColumnStats } from "@/lib/ingest/csv";
import { EXAMPLES } from "@/lib/ingest/examples";
import type { Preview } from "@/lib/ingest/fetch-preview";
import {
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
import "./new-run.css";
import "./terra.css";

const EASE = [0.22, 1, 0.36, 1] as const;
const HEAD_BYTES = 2 * 1024 * 1024;
const SHOWN_ROWS = 6;

type Mode = "link" | "file";
type Status = "idle" | "loading" | "ready" | "error";

/** What the chips and the table need, from either a link preview or a local file. */
interface Table {
  label: string;
  columns: string[];
  stats: ColumnStats[];
  sample: string[][];
  rows: number | null;
  rowsExact: boolean;
  /** Link mode: the pasted link was rewritten to a direct download. */
  rewrittenFrom?: string;
  resolvedUrl?: string;
}

interface Chips {
  target: string;
  problemType: ProblemType;
  metric: MetricId;
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

const fmtRows = (n: number | null, exact: boolean) => (n == null ? "rows: unknown" : `${exact ? "" : "≈ "}${n.toLocaleString("en-US")} rows`);
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export function NewRunForm({ maxExperiments, llmAvailable }: { maxExperiments: number; llmAvailable: boolean }) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [mode, setMode] = useState<Mode>("link");
  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState<Table | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileHead, setFileHead] = useState("");
  const [chips, setChips] = useState<Chips | null>(null);
  const [touched, setTouchedState] = useState(false); // the user edited a chip: later suggestions don't overwrite it
  const [why, setWhy] = useState<{ text: string; source: Suggestion["source"] } | null>(null);
  const [goalPlain, setGoalPlain] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);
  const [experiments, setExperiments] = useState(Math.min(DEFAULT_EXPERIMENTS, maxExperiments));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const reqId = useRef(0);
  const ctrl = useRef<AbortController | null>(null);
  const lastPreviewed = useRef<{ url: string; goal: string } | null>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const touchedRef = useRef(false);
  const setTouched = (v: boolean) => {
    touchedRef.current = v;
    setTouchedState(v);
  };

  const applySuggestion = useCallback((s: Suggestion | null) => {
    if (!s) return;
    setWhy({ text: s.why, source: s.source });
    setGoalPlain(s.goalPlain);
    if (!touchedRef.current) setChips({ target: s.target, problemType: s.problemType, metric: s.metric });
  }, []);

  /** Fetch the preview (and suggestions) for a link. Stale responses are dropped. */
  const runPreview = useCallback(
    async (rawUrl: string, sentence: string, opts: { refineOnly?: boolean } = {}) => {
      const u = rawUrl.trim();
      if (!u) return;
      const id = ++reqId.current;
      ctrl.current?.abort();
      const ac = new AbortController();
      ctrl.current = ac;
      lastPreviewed.current = { url: u, goal: sentence.trim() };
      if (opts.refineOnly) setRefining(true);
      else {
        setStatus("loading");
        setError(null);
        setSubmitError(null);
      }
      try {
        const res = await fetch("/api/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: u, goal: sentence.trim() }),
          signal: ac.signal,
        });
        const body = (await res.json()) as { preview?: Preview; suggestion?: Suggestion | null; error?: string };
        if (id !== reqId.current) return;
        if (!res.ok || !body.preview) {
          if (opts.refineOnly) return; // keep the preview we have; the sentence just didn't help
          setStatus("error");
          setError(body.error ?? "Couldn't read that link.");
          setTable(null);
          setChips(null);
          return;
        }
        const p = body.preview;
        if (!opts.refineOnly) {
          setTable({
            label: hostOf(p.finalUrl) || "link",
            columns: p.columns,
            stats: p.stats,
            sample: p.sample,
            rows: p.rows,
            rowsExact: p.rowsExact,
            rewrittenFrom: p.rewritten ? hostOf(p.url) : undefined,
            resolvedUrl: p.resolvedUrl,
          });
          touchedRef.current = false;
          setTouchedState(false);
        }
        applySuggestion(body.suggestion ?? suggest(p.stats, sentence));
        setStatus("ready");
      } catch (e) {
        if ((e as Error).name === "AbortError" || id !== reqId.current) return;
        if (!opts.refineOnly) {
          setStatus("error");
          setError("Couldn't reach the server. Check your connection and try again.");
        }
      } finally {
        if (id === reqId.current) setRefining(false);
      }
    },
    [applySuggestion],
  );

  // Auto-preview: debounce typing; a paste or an example click previews at once (see handlers).
  useEffect(() => {
    if (mode !== "link") return;
    const u = url.trim();
    if (!u || lastPreviewed.current?.url === u) return;
    if (!/^https?:\/\/\S+\.\S+/.test(u)) return;
    const t = setTimeout(() => void runPreview(u, goal), 650);
    return () => clearTimeout(t);
  }, [url, goal, mode, runPreview]);

  // The sentence changed after a preview: ask again for suggestions (the server caches the file).
  useEffect(() => {
    if (mode !== "link" || status !== "ready" || !table) return;
    const last = lastPreviewed.current;
    if (!last || last.url !== url.trim() || last.goal === goal.trim()) return;
    const t = setTimeout(() => void runPreview(url, goal, { refineOnly: true }), 900);
    return () => clearTimeout(t);
  }, [goal, url, mode, status, table, runPreview]);

  // File mode: the same chips, from a local parse + the same heuristics (no LLM, nothing leaves the browser yet).
  useEffect(() => {
    if (mode !== "file" || !table || touchedRef.current) return;
    const t = setTimeout(() => applySuggestion(suggest(table.stats, goal)), 400);
    return () => clearTimeout(t);
  }, [goal, mode, table, applySuggestion]);

  const onFile = async (f: File | null) => {
    setSubmitError(null);
    setError(null);
    setFile(f);
    setTable(null);
    setChips(null);
    setTouched(false);
    if (!f) return setStatus("idle");
    if (f.size > MAX_UPLOAD_BYTES) {
      setStatus("error");
      setError(`The file is ${(f.size / 1048576).toFixed(1)} MB; uploads are limited to 5 MB. Paste a link instead (up to 50 MB).`);
      return;
    }
    const text = await f.slice(0, HEAD_BYTES).text();
    const partial = f.size > HEAD_BYTES;
    const parsed = parseTable(text, { partial, sampleRows: 50 });
    if (parsed.columns.length < 2) {
      setStatus("error");
      setError("We couldn't find at least two columns. Is this a CSV with a header row?");
      return;
    }
    setFileHead(text);
    setTable({ label: f.name, columns: parsed.columns, stats: parsed.stats, sample: parsed.sample, rows: parsed.parsedRows, rowsExact: !partial });
    setStatus("ready");
    applySuggestion(suggest(parsed.stats, goal));
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    ctrl.current?.abort();
    reqId.current++;
    lastPreviewed.current = null;
    setMode(m);
    setStatus("idle");
    setError(null);
    setSubmitError(null);
    setTable(null);
    setChips(null);
    setWhy(null);
    setGoalPlain(null);
    setFile(null);
    setTouched(false);
  };

  const pickExample = (u: string) => {
    if (mode !== "link") switchMode("link");
    setUrl(u);
    void runPreview(u, goal);
  };

  const setTarget = (target: string) => {
    if (!table) return;
    const s = suggestionFor(table.stats, target, "your pick");
    setTouched(true);
    setChips({ target, problemType: s.problemType, metric: s.metric });
    setGoalPlain(s.goalPlain);
    setWhy(null);
  };
  const setMetric = (m: MetricId) => {
    setTouched(true);
    setChips((c) => (c ? { ...c, metric: m } : c));
  };

  const ready = status === "ready" && !!table && !!chips;

  // When a preview lands, bring the Start button into view (the table can push it below the fold on laptops).
  const tableKey = table ? `${table.label}|${table.columns.join("|")}` : "";
  useEffect(() => {
    if (!tableKey) return;
    const t = setTimeout(() => startRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" }), 450);
    return () => clearTimeout(t);
  }, [tableKey, reduced]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !chips || submitting) return;
    setSubmitError(null);
    let init: RequestInit;
    if (mode === "link") {
      const v = validateUrlRunRequest({ url: url.trim(), target: chips.target, metric: chips.metric, goal, maxExperiments: experiments }, { maxExperiments });
      if (!v.ok) return setSubmitError(v.error);
      init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), target: chips.target, metric: chips.metric, goal: goal.trim(), maxExperiments: experiments }),
      };
    } else {
      if (!file) return;
      const v = validateRunRequest(
        { fileName: file.name, fileBytes: file.size, head: fileHead, complete: file.size <= HEAD_BYTES, target: chips.target, metric: chips.metric, goal, maxExperiments: experiments },
        { maxExperiments },
      );
      if (!v.ok) return setSubmitError(v.error);
      const fd = new FormData();
      fd.set("file", file);
      fd.set("target", chips.target);
      fd.set("metric", chips.metric);
      fd.set("goal", goal.trim());
      fd.set("maxExperiments", String(experiments));
      init = { method: "POST", body: fd };
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/runs", init);
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) {
        setSubmitError(body.error ?? "Something went wrong starting the run.");
        setSubmitting(false);
        return;
      }
      router.push(`/runs/${body.id}`);
    } catch {
      setSubmitError("Couldn't reach the server. Check your connection and try again.");
      setSubmitting(false);
    }
  };

  const enter = reduced ? { opacity: 0 } : { opacity: 0, y: 14 };
  const shownCols = table?.columns ?? [];
  const statByName = new Map(table?.stats.map((s) => [s.name, s]) ?? []);

  return (
    <form onSubmit={start} noValidate className="mt-[clamp(2.5rem,6vh,4rem)]">
      {/* ---------------------------------------------------------------- the one input */}
      {mode === "link" ? (
        <div>
          <label htmlFor="nr-url" className="font-mono text-[11px] tracking-[0.2em] text-[var(--lp-ink-3)] uppercase">
            Paste a link to a CSV
          </label>
          <div className="nr-field mt-3 flex items-center gap-3" data-error={status === "error" ? "" : undefined}>
            <input
              id="nr-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (!e.target.value.trim()) {
                  reqId.current++;
                  ctrl.current?.abort();
                  lastPreviewed.current = null;
                  setStatus("idle");
                  setTable(null);
                  setChips(null);
                  setError(null);
                }
              }}
              onPaste={(e) => {
                const pasted = e.clipboardData.getData("text").trim();
                if (pasted) {
                  e.preventDefault();
                  setUrl(pasted);
                  void runPreview(pasted, goal);
                }
              }}
              placeholder="https://github.com/…/data.csv"
              className="py-3 font-mono text-[clamp(1rem,1.6vw,1.2rem)]"
              aria-describedby="nr-url-help"
              aria-invalid={status === "error"}
            />
            {status === "loading" && <span className="shrink-0 font-mono text-[11px] text-[var(--lp-ink-3)]">reading…</span>}
          </div>
          <div className="h-px">{status === "loading" && <div className="nr-scan" aria-hidden />}</div>
          <p id="nr-url-help" className="mt-3 text-[13px] text-[var(--lp-ink-3)]">
            Public https links. GitHub, Google Sheets &amp; Drive, Hugging Face and Dropbox share links work as they are.
          </p>
        </div>
      ) : (
        <div>
          <span className="font-mono text-[11px] tracking-[0.2em] text-[var(--lp-ink-3)] uppercase">Upload a CSV</span>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void onFile(e.dataTransfer.files?.[0] ?? null);
            }}
            className={`mt-3 flex cursor-pointer flex-col items-start gap-1 border-b border-dashed py-5 transition-colors ${
              dragging ? "border-[var(--lp-signal)]" : "border-[oklch(88%_0.02_85/0.3)] hover:border-[oklch(88%_0.02_85/0.6)]"
            }`}
          >
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
            <span className="font-mono text-[clamp(1rem,1.6vw,1.2rem)]">{file ? file.name : "Drop a CSV here, or click to choose one"}</span>
            <span className="text-[13px] text-[var(--lp-ink-3)]">{file ? `${(file.size / 1024).toFixed(0)} KB · click to replace` : "Header row required · up to 5 MB"}</span>
          </label>
        </div>
      )}

      {/* the optional sentence */}
      <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <label htmlFor="nr-goal" className="font-display text-[1.35rem] text-[var(--lp-ink-2)] italic">
          What do you want to predict?
        </label>
        <span className="text-[12px] text-[var(--lp-ink-3)]">optional</span>
      </div>
      <div className="nr-field mt-1">
        <input
          id="nr-goal"
          type="text"
          maxLength={500}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. which customers will cancel next month"
          className="py-2.5 text-[16px]"
        />
      </div>

      {error && (
        <p role="alert" className="mt-4 max-w-[70ch] text-[15px] text-[var(--crash)]">
          {error}
        </p>
      )}

      {/* examples, for people without data */}
      {mode === "link" && status !== "ready" && (
        <div className="mt-8 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[13px] text-[var(--lp-ink-3)]">No data at hand? Try</span>
          {EXAMPLES.map((ex) => (
            <button key={ex.url} type="button" className="nr-example" aria-pressed={url.trim() === ex.url} onClick={() => pickExample(ex.url)} title={ex.url}>
              {ex.name} <span className="text-[var(--lp-ink-3)]">· {ex.blurb}</span>
            </button>
          ))}
        </div>
      )}

      {/* ---------------------------------------------------------------- preview + chips */}
      <AnimatePresence initial={false}>
        {ready && table && chips && (
          <motion.section
            key={`${table.label}-${table.columns.join("|")}`}
            initial={enter}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.55, ease: EASE }}
            aria-label="Preview and settings"
            className="mt-[clamp(2.2rem,5vh,3.2rem)]"
          >
            <p className="font-mono text-[12px] text-[var(--lp-ink-3)] tabular-nums">
              <span className="text-[var(--lp-ink-2)]">{table.label}</span> · {fmtRows(table.rows, table.rowsExact)} · {table.columns.length} columns
              {table.rewrittenFrom && <> · share link → direct download</>}
            </p>

            {/* the run, as one editable sentence */}
            <p className="mt-5 font-display text-[clamp(1.6rem,3.2vw,2.35rem)] leading-[1.35] text-[var(--lp-ink)]">
              Predict{" "}
              <span className="nr-chip">
                <select aria-label="Column to predict" value={chips.target} onChange={(e) => setTarget(e.target.value)}>
                  {table.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </span>
              , as{" "}
              <span className="text-[var(--lp-ink-2)] italic" title="Decided from the column's values, the same way the engine decides it">
                {PROBLEM_LABEL[chips.problemType]}
              </span>
              , scored by{" "}
              <span className="nr-chip">
                <select aria-label="Metric" value={chips.metric} onChange={(e) => setMetric(e.target.value as MetricId)}>
                  {VALID_METRICS[chips.problemType].map((m) => (
                    <option key={m} value={m}>
                      {METRIC_LABEL[m]}
                    </option>
                  ))}
                </select>
              </span>
              , over at most{" "}
              <span className="nr-chip">
                <select aria-label="Experiments" value={experiments} onChange={(e) => setExperiments(Number(e.target.value))} className="font-mono tabular-nums">
                  {Array.from({ length: maxExperiments }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </span>{" "}
              experiments.
            </p>
            <p className="mt-3 max-w-[72ch] text-[14px] leading-relaxed text-[var(--lp-ink-3)]">
              {refining ? (
                <span className="text-[var(--lp-ink-2)]">Reading your sentence…</span>
              ) : touched ? (
                <>{goalPlain}</>
              ) : (
                <>
                  {goalPlain} {why && <span className="text-[var(--lp-ink-3)]">Why: {why.text.replace(/\.$/, "")}.</span>}{" "}
                  <span className="font-mono text-[11px]">{why?.source === "llm" ? "· suggested by gpt-oss" : "· suggested by rules of thumb"}</span>
                </>
              )}
            </p>

            {/* compact table */}
            <div className="mt-7 overflow-x-auto [mask-image:linear-gradient(to_right,#000_85%,transparent)]">
              <table className="nr-table font-mono text-[12px] text-[var(--lp-ink-2)] tabular-nums">
                <thead>
                  <tr>
                    {shownCols.map((c) => (
                      <th key={c} data-target={c === chips.target ? "" : undefined} className="align-bottom font-normal">
                        <span className="block text-[12px]">{c}</span>
                        <span className="block text-[10px] text-[var(--lp-ink-3)]">{KIND_LABEL[statByName.get(c)?.kind ?? "text"]}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.sample.slice(0, SHOWN_ROWS).map((r, i) => (
                    <tr key={i}>
                      {shownCols.map((c, j) => (
                        <td key={c} data-target={c === chips.target ? "" : undefined} title={r[j]}>
                          {r[j] === "" ? <span className="text-[var(--lp-ink-3)]">·</span> : r[j]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* ---------------------------------------------------------------- start */}
      <div ref={startRef} className="mt-[clamp(2.2rem,5vh,3rem)] flex scroll-mb-16 flex-wrap items-center gap-x-6 gap-y-4">
        <button type="submit" disabled={!ready || submitting} className="lp-cta lp-cta-primary disabled:cursor-not-allowed disabled:opacity-35">
          <span className="relative z-10">{submitting ? "Starting…" : "Start"}</span>
          <span aria-hidden className="lp-cta-arrow relative z-10">
            →
          </span>
        </button>
        <button
          type="button"
          onClick={() => switchMode(mode === "link" ? "file" : "link")}
          className="text-[14px] text-[var(--lp-ink-2)] underline decoration-[oklch(88%_0.02_85/0.3)] underline-offset-4 transition-colors hover:text-[var(--lp-ink)] hover:decoration-[var(--lp-signal)]"
        >
          {mode === "link" ? "or upload a file" : "or paste a link"}
        </button>
      </div>
      {submitError && (
        <p role="alert" className="mt-4 text-[15px] text-[var(--crash)]">
          {submitError}
        </p>
      )}
      <p className="mt-6 max-w-[64ch] text-[13px] leading-relaxed text-[var(--lp-ink-3)]">
        Runs on free Groq and Gemini models; data rows are never sent to Gemini.
        {!llmAvailable && " This server has no model key configured, so suggestions come from rules of thumb only."}
      </p>
    </form>
  );
}
