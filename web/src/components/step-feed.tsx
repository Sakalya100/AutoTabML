"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  feedSignature,
  inFlight,
  roleDoing,
  roleLabel,
  type AgentStepItem,
  type AgentStepLine,
  type ExperimentItem,
  type FeedItem,
  type FinishedItem,
  type ReportItem,
  type RunStartedItem,
  type StoppedItem,
} from "@/lib/feed";
import { CATEGORY_LABEL, fmtCost, fmtDuration, fmtValue, SIGNAL_LABEL } from "@/lib/format";
import { describeGap, formatScore, formatSe, metricInfo } from "@/lib/metrics";
import { answerKind, plainIdea, plainVerdict, stopPhrase } from "@/lib/story";
import { plainGateReason } from "@/lib/verdict";
import type { Metric } from "@/lib/schema";

const EASE = [0.22, 1, 0.36, 1] as const;

/** True once the feed has mounted: parts that appear after that animate in; the initial backlog does not. */
const AnimateCtx = createContext(false);
function useEnter() {
  const ready = useContext(AnimateCtx);
  const reduced = useReducedMotion();
  const [animate] = useState(ready && !reduced);
  return animate;
}

interface Props {
  items: FeedItem[];
  metric: Metric | null;
  selectedId: string | null;
  /** The user's explicit pick (scrolls the message into view when it changes). */
  focusId?: string | null;
  onSelect: (id: string) => void;
  /** The run is still producing events (live, or a simulation that is playing). */
  streaming: boolean;
  /** Shown while the run has produced no events yet. */
  emptyHint?: string;
  heuristic?: boolean;
  /** The agent step running right now, if any (agentic runs): names who is working in the "thinking" line. */
  activity?: { role: string; expId: string | null } | null;
  className?: string;
}

/**
 * The agent's activity, in the landing's typographic language: one entry per idea, plain words first (what it tried,
 * what happened), the precise numbers second, the gate's full reasoning on selection. No bubbles, no cards.
 */
export function StepFeed({ items, metric, selectedId, focusId, onSelect, streaming, emptyHint, heuristic, activity, className = "" }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastTop = useRef(0);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [ready, setReady] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    const r = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const sig = feedSignature(items);
  const flying = inFlight(items);
  const last = items.at(-1);
  const thinking = streaming && !flying && last?.kind !== "finished" && last?.kind !== "report" && !(last?.kind === "agent_step" && last.running);

  // Follow the newest message unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (follow.current)
      el.scrollTo({
        top: el.scrollHeight,
        behavior: ready && !reduced ? "smooth" : "auto",
      });
    else setUnseen((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, thinking]);

  // A pick made elsewhere (the tree, the ledger) brings its message into view.
  useEffect(() => {
    if (!focusId) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-exp="${focusId}"]`);
    if (!el) return;
    const box = scroller.current!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top + 40 || r.bottom > box.bottom) {
      follow.current = false;
      setFollowing(false);
      el.scrollIntoView({
        block: "center",
        behavior: reduced ? "auto" : "smooth",
      });
    }
  }, [focusId, reduced]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
    if (atBottom) {
      follow.current = true;
      setFollowing(true);
      setUnseen(0);
    } else if (el.scrollTop < lastTop.current - 2) {
      follow.current = false;
      setFollowing(false);
    }
    lastTop.current = el.scrollTop;
  };

  const jump = () => {
    follow.current = true;
    setFollowing(true);
    setUnseen(0);
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: reduced ? "auto" : "smooth",
    });
  };

  const nExp = items.filter((i) => i.kind === "experiment" && i.decision).length;
  const nKept = items.filter((i) => i.kind === "experiment" && i.decision?.verdict === "keep").length;

  return (
    <AnimateCtx.Provider value={ready}>
      <section aria-label="What the agent is doing" className={`relative flex min-h-0 flex-col overflow-hidden ${className}`}>
        <header className="flex items-baseline gap-3 px-5 pt-4 pb-3 sm:px-6">
          <span className="relative flex size-1.5 translate-y-[-2px]" aria-hidden>
            {streaming && <span className="absolute inline-flex size-full animate-ping rounded-full bg-best opacity-60" />}
            <span className={`relative inline-flex size-1.5 rounded-full ${streaming ? "bg-best" : "bg-ink-3"}`} />
          </span>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-3">{streaming ? "Working" : "What it did"}</h2>
          <span className="ml-auto font-mono text-[11px] text-ink-3 tabular">
            {nExp} tried · <span className="text-best">{nKept} kept</span>
          </span>
        </header>

        <div
          ref={scroller}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-2 pb-16 [mask-image:linear-gradient(to_bottom,transparent,#000_28px,#000_calc(100%-40px),transparent)] sm:px-6"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          {items.length === 0 && !streaming && <p className="py-10 text-sm text-ink-3">Nothing was recorded.</p>}
          <ol>
            {items.map((it) => (
              <li key={it.key} className="border-t border-[var(--lp-hair)] first:border-t-0">
                {it.kind === "run_started" && <RunStartedMsg item={it} />}
                {it.kind === "experiment" && (
                  <ExperimentMsg item={it} metric={metric} selected={it.id === selectedId} live={it === flying && streaming} onSelect={onSelect} />
                )}
                {it.kind === "stopped" && <StoppedMsg item={it} />}
                {it.kind === "finished" && <FinishedMsg item={it} metric={metric} />}
                {it.kind === "agent_step" && <RunStepMsg item={it} />}
                {it.kind === "report" && <ReportMsg item={it} />}
              </li>
            ))}
            <AnimatePresence initial={false}>
              {(thinking || (streaming && items.length === 0)) && (
                <motion.li
                  key="thinking"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="border-t border-[var(--lp-hair)] py-4"
                >
                  <Thinking
                    text={
                      activity && !activity.expId
                        ? `${roleDoing(activity.role)}…`
                        : items.length === 0
                          ? (emptyHint ?? "Reading the data")
                          : activity
                            ? `${roleDoing(activity.role)}…`
                            : last?.kind === "stopped"
                              ? "Running the one final test, on data it has never seen"
                              : heuristic
                                ? "Choosing the next idea"
                                : "Thinking of the next idea"
                    }
                  />
                </motion.li>
              )}
            </AnimatePresence>
          </ol>
        </div>

        <AnimatePresence>
          {!following && (
            <motion.button
              key="jump"
              onClick={jump}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
              transition={{ duration: 0.22, ease: EASE }}
              className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper"
            >
              <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
                <path d="M6 2v7M2.5 6 6 9.5 9.5 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Latest
              {unseen > 0 && streaming ? <span className="text-paper/70">· new</span> : null}
            </motion.button>
          )}
        </AnimatePresence>
      </section>
    </AnimateCtx.Provider>
  );
}

/* ---------------------------------------------------------------------------------------------------- */

function Enter({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const animate = useEnter();
  return (
    <motion.div
      className={className}
      initial={animate ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.36, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

/** Reveals text left-to-right without reflow: the untyped rest is laid out but transparent. */
function Typed({ text, play, cps = 140 }: { text: string; play: boolean; cps?: number }) {
  const [n, setN] = useState(play ? 0 : text.length);
  useEffect(() => {
    if (!play) return;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(text.length, Math.floor(((t - start) / 1000) * cps));
      setN(k);
      if (k < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play, text, cps]);
  if (!play || n >= text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, n)}
      <span className="text-transparent" aria-hidden>
        {text.slice(n)}
      </span>
    </>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2.5 pl-10 text-[14px] text-ink-3">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="size-1 rounded-full bg-ink-3"
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18, ease: "easeInOut" }}
          />
        ))}
      </span>
      {text}
    </div>
  );
}

/* ---- run-level messages ------------------------------------------------------------------------------ */

/** A run-level moment: a small mono kicker, one display line, plain words, then the precise detail. */
function Moment({ kicker, title, tone, children }: { kicker: string; title: React.ReactNode; tone?: "signal"; children?: React.ReactNode }) {
  return (
    <Enter className="py-5">
      <p className={`font-mono text-[10.5px] uppercase tracking-[0.2em] ${tone ? "text-best" : "text-ink-3"}`}>{kicker}</p>
      <p className="mt-1.5 font-display text-[1.6rem] leading-[1.08] text-ink">{title}</p>
      {children}
    </Enter>
  );
}

function RunStartedMsg({ item }: { item: RunStartedItem }) {
  const m = metricInfo(item.metric);
  const kind = answerKind(item.problemType, null);
  return (
    <Moment
      kicker="The task"
      title={
        item.target ? (
          <>
            Predict <span className="italic">{item.target}</span>
            {kind ? <span className="text-ink-3"> ({kind})</span> : null}
          </>
        ) : (
          "A new survey"
        )
      }
    >
      {item.nRows != null && (
        <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">
          From {item.nCols != null ? `${Math.max(0, item.nCols - 1)} columns of ` : ""}
          {item.nRows.toLocaleString("en-US")} rows. It only sees a summary and a few sample rows, and a slice of the data stays locked away for one final test.
        </p>
      )}
      <p className="mt-2 font-mono text-[11.5px] leading-relaxed text-ink-3 tabular">
        {m.label} · {m.greaterIsBetter ? "higher is better" : "lower is better"} · repeated k-fold CV
        {item.maxExperiments ? ` · up to ${item.maxExperiments} ideas` : ""}
        {item.columnKinds.length > 0 && ` · ${item.columnKinds.map(([k, n]) => `${n} ${k}`).join(", ")}`}
      </p>
      {item.flagged.length > 0 && (
        <p className="mt-1 font-mono text-[11.5px] text-best">
          flagged:{" "}
          {item.flagged
            .slice(0, 3)
            .map((f) => `${f.name} (${f.flags[0].replace(/_/g, " ")})`)
            .join(", ")}
        </p>
      )}
    </Moment>
  );
}

function StoppedMsg({ item }: { item: StoppedItem }) {
  const phrase = stopPhrase(item.reason);
  const fired = item.signals.filter((s) => s.fired === true).length;
  const known = item.signals.filter((s) => s.fired != null).length;
  return (
    <Moment kicker="It stopped" tone="signal" title={phrase ? `It ${phrase}.` : "It stopped."}>
      <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">
        {item.reason === "ceiling" ? "Progress had levelled off: more ideas were unlikely to beat chance. " : ""}
        {known > 0 && `${fired} of ${known} stop signals agreed.`}
      </p>
      <ul className="mt-2.5 space-y-1">
        {item.signals.map((s) => (
          <li key={s.key} className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 font-mono text-[11.5px] text-ink-3 tabular">
            <span
              aria-hidden
              className={`size-1.5 translate-y-[-1px] rounded-full ${s.fired === true ? "bg-best" : s.fired === false ? "border border-ink-3" : "border border-dashed border-ink-3"}`}
            />
            <span className={s.fired ? "text-ink-2" : ""}>
              {(SIGNAL_LABEL[s.key]?.title ?? s.key.replace(/_/g, " ")).toLowerCase()} · {s.fired === true ? "yes" : s.fired === false ? "no" : "n/a"}
            </span>
            {s.fired != null && (
              <span>
                {fmtValue(s.value)} / {fmtValue(s.threshold)}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12.5px] leading-snug text-ink-3">{item.summary}</p>
    </Moment>
  );
}

function FinishedMsg({ item, metric }: { item: FinishedItem; metric: Metric | null }) {
  return (
    <Moment
      kicker="The final test"
      tone="signal"
      title={
        <>
          <span className="font-mono text-[1.45rem] tracking-tight tabular">{formatScore(metric, item.test)}</span>{" "}
          <span className="text-ink-2">on data it never saw.</span>
        </>
      }
    >
      <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">
        {item.gap > 0 ? "A little below its own estimate" : item.gap < 0 ? "Better than its own estimate" : "Exactly its own estimate"}:{" "}
        {describeGap(metric, item.gap)}.
      </p>
      <p className="mt-2 font-mono text-[11.5px] text-ink-3 tabular">
        dev CV {formatScore(metric, item.devCvMean)} · select {formatScore(metric, item.select)} · test {formatScore(metric, item.test)} · best {item.bestId} ·{" "}
        {item.nExperiments} ideas · {fmtDuration(item.wallTimeS)} · {fmtCost(item.costUsd)}
      </p>
    </Moment>
  );
}

/* ---- one experiment ---------------------------------------------------------------------------------- */

const DOT: Record<string, string> = {
  kept: "bg-best",
  dropped: "border border-ink-3",
  broke: "bg-crash",
  running: "bg-best",
};

function ExperimentMsg({
  item,
  metric,
  selected,
  live,
  onSelect,
}: {
  item: ExperimentItem;
  metric: Metric | null;
  selected: boolean;
  live: boolean;
  onSelect: (id: string) => void;
}) {
  const enter = useEnter();
  const status = item.decision ? item.decision.verdict : "running";
  const v = plainVerdict({ status, reason: item.decision?.reason ?? "", index: item.index });
  const fails = item.attempts.filter((a) => !a.ok);
  const okAttempt = item.attempts.find((a) => a.ok);
  const idea = plainIdea(item.idea);
  const g = item.decision?.gate;
  const runningStep = live ? item.steps.findLast((x) => x.running) : undefined;

  return (
    <motion.article
      data-exp={item.id}
      initial={enter ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
      onClick={() => onSelect(item.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(item.id);
        }
      }}
      tabIndex={0}
      aria-current={selected || undefined}
      aria-label={`Idea ${item.index + 1}: ${idea}. ${v.text}, ${v.outcome}.`}
      className={`group relative -mx-3 grid cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 rounded-lg px-3 py-3.5 transition-colors duration-300 ${
        selected ? "bg-[rgb(var(--lp-signal-rgb,255_181_71)/0.06)]" : "hover:bg-[rgb(var(--lp-ink-rgb,236_231_220)/0.03)]"
      }`}
    >
      <div className="flex flex-col items-start pt-[0.42rem]">
        <span className={`size-2 rounded-full ${DOT[v.tone]} ${v.tone === "running" ? "animate-pulse" : ""}`} aria-hidden />
        <span className="mt-2 font-mono text-[10px] text-ink-3 tabular">{String(item.index + 1).padStart(2, "0")}</span>
      </div>

      <div className="min-w-0">
        <p className="text-[16px] leading-snug text-ink">
          <span className="text-ink-3 italic">Tried </span>
          <Typed text={idea} play={enter && live} cps={80} />
        </p>
        <div className={`mt-1 text-[14px] ${v.tone === "kept" ? "text-best" : v.tone === "broke" ? "text-crash" : "text-ink-2"}`}>
          {v.tone === "running" ? (
            <Running repairing={fails.length > 0} label={runningStep ? `${roleDoing(runningStep.role)}…` : undefined} />
          ) : (
            <Enter>
              {v.text} <span aria-hidden>→</span> <span className="font-medium">{v.outcome}</span>
              {item.decision?.newBest && item.index > 0 && <span className="ml-2 font-mono text-[11px] uppercase tracking-[0.14em]">new best</span>}
            </Enter>
          )}
        </div>

        {/* the precise record, secondary */}
        <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-ink-3 tabular">
          {item.id}
          {item.scored && (
            <>
              {" "}
              · CV {formatScore(metric, item.scored.cvMean)} ± {formatSe(item.scored.cvSe)} · select {formatScore(metric, item.scored.select)}
            </>
          )}
          {g?.gainSe != null && (
            <>
              {" "}
              · {g.gainSe >= 0 ? "+" : "−"}
              {Math.abs(g.gainSe).toFixed(2)} SE
            </>
          )}
          {g?.p != null && <> · p {fmtP(g.p)}</>}
          {okAttempt && <> · {fmtDuration(okAttempt.durationS)}</>}
          {okAttempt && okAttempt.attempt > 0 && <span className="text-best"> · repaired</span>}
          {item.llmCalls > 0 && (
            <>
              {" "}
              · {item.llmCalls} LLM call{item.llmCalls === 1 ? "" : "s"} {fmtCost(item.costUsd)}
            </>
          )}
          {" · "}
          {(CATEGORY_LABEL[item.idea.category] ?? item.idea.category).toLowerCase()}
          {item.idea.radical && " · radical"}
        </p>

        {item.steps.length > 0 && (
          <ol className="mt-2 space-y-0.5" aria-label="Agent steps">
            {item.steps.map((st, i) => (
              <StepLine key={st.stepId || i} step={st} />
            ))}
          </ol>
        )}
        {item.hpoTrials > 0 && <p className="mt-1 font-mono text-[11px] text-ink-3 tabular">{item.hpoTrials} tuning trials</p>}
        {item.logs.length > 0 && (
          <details className="group/log mt-1.5 text-[12px]" onClick={(e) => e.stopPropagation()}>
            <summary className="cursor-pointer list-none font-mono text-[11px] text-ink-3 marker:hidden">
              <span className="underline decoration-[var(--lp-hair)] underline-offset-4">
                sandbox log · {item.logs.length} line{item.logs.length === 1 ? "" : "s"}
              </span>
            </summary>
            <pre className="mt-1.5 max-h-48 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-3">{item.logs.join("\n")}</pre>
          </details>
        )}

        {fails.map((a) => (
          <Enter key={a.attempt} className="mt-2">
            <details className="group/err text-[12.5px]" onClick={(e) => e.stopPropagation()}>
              <summary className="cursor-pointer list-none text-crash marker:hidden">
                Attempt {a.attempt + 1} failed ({a.errorKind ?? "error"})
                {a.attempt + 1 < item.attempts.length || (!item.decision && item.attempts.at(-1) === a) ? (
                  <span className="text-ink-3">, so it repaired the code</span>
                ) : null}
                <span className="ml-1 text-ink-3 underline decoration-[var(--lp-hair)] underline-offset-4 group-open/err:hidden">show error</span>
              </summary>
              {a.errorTail && (
                <pre className="mt-1.5 max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-3">
                  {a.errorTail.split("\n").slice(-8).join("\n")}
                </pre>
              )}
            </details>
          </Enter>
        ))}

        <AnimatePresence initial={false}>
          {selected && (
            <motion.div
              key="more"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ duration: 0.28, ease: EASE }}
              className="mt-2.5 space-y-2 border-l border-[var(--lp-hair)] pl-3 text-[13px] leading-relaxed text-ink-2"
            >
              <p className="text-ink">{item.idea.title}</p>
              {item.idea.rationale && <p>{item.idea.rationale}</p>}
              {item.decision?.reason && <p className="text-[12.5px] text-ink-3">{plainGateReason(item.decision.reason, item.decision.verdict, metric)}</p>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.article>
  );
}

function fmtP(p: number): string {
  if (p < 0.001) return "<0.001";
  return p >= 0.1 ? p.toFixed(2) : p.toFixed(3);
}

function Running({ repairing, label }: { repairing: boolean; label?: string }) {
  const reduced = useReducedMotion();
  return (
    <span className="inline-flex items-center gap-3 text-ink-2">
      {label ?? (repairing ? "Re-running the repaired code…" : "Testing it…")}
      <span className="relative inline-block h-px w-20 overflow-hidden bg-[var(--lp-hair)]" aria-hidden>
        {!reduced && (
          <motion.span
            className="absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-best to-transparent"
            initial={{ x: "-100%" }}
            animate={{ x: "200%" }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </span>
    </span>
  );
}

/* ---- agent steps (agentic engine) -------------------------------------------------------------------- */

/** One agent step as a single line: mono role label, then its plain one-liner. Amber while it runs. */
function StepLine({ step }: { step: AgentStepLine }) {
  const text = step.running
    ? step.inputSummary
      ? `working on ${step.inputSummary}`
      : "working…"
    : step.plain || (step.status === "error" ? "failed" : "done");
  return (
    <li className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-2 text-[12.5px] leading-snug">
      <span
        className={`truncate font-mono text-[10.5px] uppercase tracking-[0.14em] ${step.running ? "animate-pulse text-best" : step.status === "error" ? "text-crash" : "text-ink-3"}`}
        title={step.model ?? undefined}
      >
        {roleLabel(step.role)}
        {step.attempt > 0 ? ` ${step.attempt + 1}` : ""}
      </span>
      <span className={step.running ? "text-ink-3 italic" : step.status === "error" ? "text-crash" : "text-ink-2"}>{text}</span>
    </li>
  );
}

function RunStepMsg({ item }: { item: AgentStepItem }) {
  return (
    <Enter className="py-3">
      <ol>
        <StepLine step={item} />
      </ol>
    </Enter>
  );
}

function ReportMsg({ item }: { item: ReportItem }) {
  const list = (title: string, xs: string[]) =>
    xs.length > 0 && (
      <div className="mt-3">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-ink-3">{title}</p>
        <ul className="mt-1 space-y-1 text-[14px] leading-relaxed text-ink-2">
          {xs.map((x, i) => (
            <li key={i} className="grid grid-cols-[0.9rem_minmax(0,1fr)]">
              <span aria-hidden className="text-ink-3">
                –
              </span>
              <span>{x}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <Moment kicker="The report" tone="signal" title={item.plain ?? "What it found"}>
      {item.summary && <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">{item.summary}</p>}
      {list("What worked", item.whatWorked)}
      {list("Caveats", item.caveats)}
      {list("Next steps", item.nextSteps)}
    </Moment>
  );
}
