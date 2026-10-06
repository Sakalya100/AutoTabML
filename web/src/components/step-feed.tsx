"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { feedSignature, inFlight, type ExperimentItem, type FeedItem, type FinishedItem, type RunStartedItem, type StoppedItem } from "@/lib/feed";
import { CATEGORY_LABEL, fmtCost, fmtDuration, fmtValue, SIGNAL_LABEL, STOP_REASON_LABEL } from "@/lib/format";
import { describeGap, directionLabel, formatScore, formatSe, metricInfo } from "@/lib/metrics";
import type { Metric } from "@/lib/schema";
import { RadicalBadge } from "./badges";

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
  className?: string;
}

/** The agent's activity as a transcript: one message group per experiment, plus run-level messages. */
export function StepFeed({ items, metric, selectedId, focusId, onSelect, streaming, emptyHint, heuristic, className = "" }: Props) {
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
  const thinking = streaming && !flying && last?.kind !== "finished";

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

  const nExp = items.filter((i) => i.kind === "experiment").length;
  const nKept = items.filter((i) => i.kind === "experiment" && i.decision?.verdict === "keep").length;

  return (
    <AnimateCtx.Provider value={ready}>
      <section aria-label="Agent activity" className={`relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-rule bg-paper ${className}`}>
        <header className="flex items-center gap-3 border-b border-rule px-4 py-3">
          <span className="relative flex size-2" aria-hidden>
            {streaming && <span className="absolute inline-flex size-full animate-ping rounded-full bg-keep opacity-60" />}
            <span className={`relative inline-flex size-2 rounded-full ${streaming ? "bg-keep" : "bg-ink-3"}`} />
          </span>
          <h2 className="text-sm font-medium">Agent activity</h2>
          <span className="ml-auto font-mono text-[11px] text-ink-3 tabular">
            {nExp} experiment{nExp === 1 ? "" : "s"} · {nKept} kept
          </span>
        </header>

        <div
          ref={scroller}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-4 pb-8 sm:px-4"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          {items.length === 0 && !streaming && <p className="px-2 py-10 text-center text-sm text-ink-3">No activity recorded.</p>}
          <ol className="space-y-5">
            {items.map((it) => (
              <li key={it.key}>
                {it.kind === "run_started" && <RunStartedMsg item={it} />}
                {it.kind === "experiment" && <ExperimentMsg item={it} metric={metric} selected={it.id === selectedId} live={it === flying && streaming} onSelect={onSelect} />}
                {it.kind === "stopped" && <StoppedMsg item={it} />}
                {it.kind === "finished" && <FinishedMsg item={it} metric={metric} />}
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
                >
                  <Thinking
                    text={
                      items.length === 0
                        ? (emptyHint ?? "Profiling the data")
                        : last?.kind === "stopped"
                          ? "Refitting the best solution and scoring the locked test split"
                          : heuristic
                            ? "Choosing the next idea"
                            : "Proposing the next idea"
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
              className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
            >
              <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
                <path d="M6 2v7M2.5 6 6 9.5 9.5 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Jump to latest
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
    <motion.div className={className} initial={animate ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.36, ease: EASE, delay }}>
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

function Speaker({ who, children }: { who: "agent" | "sandbox" | "gate" | "harness"; children?: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink-3">
      <span>{who}</span>
      {children}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2.5 pl-[3.25rem] text-sm text-ink-3">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="size-1.5 rounded-full bg-ink-3"
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{
              duration: 1.1,
              repeat: Infinity,
              delay: i * 0.16,
              ease: "easeInOut",
            }}
          />
        ))}
      </span>
      {text}
    </div>
  );
}

/* ---- run-level messages ------------------------------------------------------------------------------ */

function SystemCard({ kicker, tone, children }: { kicker: string; tone?: "best" | "keep"; children: React.ReactNode }) {
  return (
    <Enter>
      <div className={`rounded-xl border px-4 py-3.5 ${tone === "best" ? "border-best/40 bg-best-soft" : "border-rule bg-paper-2"}`}>
        <p className={`font-mono text-[10.5px] uppercase tracking-[0.16em] ${tone === "best" ? "text-best" : "text-ink-3"}`}>{kicker}</p>
        {children}
      </div>
    </Enter>
  );
}

function RunStartedMsg({ item }: { item: RunStartedItem }) {
  const m = metricInfo(item.metric);
  return (
    <SystemCard kicker="harness · run started">
      <p className="mt-1.5 text-[15px] leading-snug text-ink">
        {item.nRows != null && (
          <>
            <span className="font-mono tabular">{item.nRows.toLocaleString("en-US")}</span> rows × <span className="font-mono tabular">{item.nCols}</span> columns
          </>
        )}
        {item.problemType && <> · {item.problemType.replace(/_/g, " ")}</>}
        {item.target && (
          <>
            {" "}
            · predict <span className="font-mono text-[13px]">{item.target}</span>
          </>
        )}
      </p>
      <p className="mt-1 text-[13px] text-ink-2">
        Scored on <span className="font-medium text-ink">{m.label}</span> ({directionLabel(item.metric)}) over repeated k-fold CV
        {item.maxExperiments ? <> · up to {item.maxExperiments} experiments</> : null}.
      </p>
      {item.columnKinds.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1.5">
          {item.columnKinds.map(([k, n]) => (
            <span key={k} className="rounded-full border border-rule-strong px-2 py-px text-[11px] text-ink-2">
              {n} {k}
            </span>
          ))}
          {item.flagged.slice(0, 3).map((f) => (
            <span key={f.name} className="rounded-full border border-best/40 px-2 py-px text-[11px] text-best" title={f.flags.join(", ")}>
              {f.name}: {f.flags[0].replace(/_/g, " ")}
            </span>
          ))}
        </p>
      )}
      <p className="mt-2.5 text-[12px] leading-snug text-ink-3">
        The agent sees a code-generated profile and at most 5 sample rows — never the full table. The test split stays locked until the end.
      </p>
    </SystemCard>
  );
}

function StoppedMsg({ item }: { item: StoppedItem }) {
  return (
    <SystemCard kicker="stop rule · run stopped" tone="best">
      <p className="mt-1 font-display text-[1.35rem] leading-tight text-ink">{STOP_REASON_LABEL[item.reason] ?? item.reason}</p>
      <ul className="mt-2.5 space-y-1.5">
        {item.signals.map((s) => (
          <li key={s.key} className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 text-[13px]">
            <span
              aria-hidden
              className={`size-2 translate-y-[-1px] rounded-full ${s.fired === true ? "bg-best" : s.fired === false ? "border-[1.5px] border-ink-3" : "border border-dashed border-ink-3"}`}
            />
            <span className={s.fired ? "text-ink" : "text-ink-3"}>
              {SIGNAL_LABEL[s.key]?.title ?? s.key.replace(/_/g, " ")}
              <span className="text-ink-3"> · {s.fired === true ? "fired" : s.fired === false ? "not fired" : "n/a"}</span>
            </span>
            {s.fired != null && (
              <span className="font-mono text-[11px] text-ink-3 tabular">
                {fmtValue(s.value)} / {fmtValue(s.threshold)}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[12.5px] leading-snug text-ink-2">{item.summary}</p>
    </SystemCard>
  );
}

function FinishedMsg({ item, metric }: { item: FinishedItem; metric: Metric | null }) {
  return (
    <SystemCard kicker="harness · locked test opened" tone="keep">
      <div className="mt-2 grid grid-cols-3 gap-3">
        <Num label="dev CV" value={formatScore(metric, item.devCvMean)} />
        <Num label="select" value={formatScore(metric, item.select)} />
        <Num label="test" value={formatScore(metric, item.test)} strong />
      </div>
      <p className="mt-2.5 text-[13px] leading-snug text-ink-2">
        Optimism gap <span className="font-mono text-ink tabular">{Math.abs(item.gap).toFixed(4)}</span> — {describeGap(metric, item.gap)}.
      </p>
      <p className="mt-1 text-[12px] text-ink-3">
        best = <span className="font-mono">{item.bestId}</span> · {item.nExperiments} experiments · {fmtDuration(item.wallTimeS)} · {fmtCost(item.costUsd)}
      </p>
    </SystemCard>
  );
}

function Num({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-3">{label}</div>
      <div className={`font-mono text-lg tabular ${strong ? "font-semibold text-ink" : "text-ink-2"}`}>{value}</div>
    </div>
  );
}

/* ---- one experiment ---------------------------------------------------------------------------------- */

const VERDICT = {
  keep: {
    label: "Kept",
    icon: "✓",
    box: "border-keep/45 bg-keep/10",
    text: "text-keep",
    dot: "bg-keep",
  },
  discard: {
    label: "Discarded",
    icon: "×",
    box: "border-rule-strong bg-paper",
    text: "text-ink-2",
    dot: "border border-discard bg-paper",
  },
  crash: {
    label: "Crashed",
    icon: "!",
    box: "border-crash/45 bg-crash/10",
    text: "text-crash",
    dot: "bg-crash",
  },
} as const;

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
  const v = item.decision ? VERDICT[item.decision.verdict] : null;
  const fails = item.attempts.filter((a) => !a.ok);
  const okAttempt = item.attempts.find((a) => a.ok);

  return (
    <motion.article
      data-exp={item.id}
      initial={enter ? { opacity: 0, y: 10 } : false}
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
      aria-label={`Experiment ${item.id}: ${item.idea.title}`}
      className={`group grid cursor-pointer grid-cols-[2.75rem_minmax(0,1fr)] gap-x-2 rounded-xl py-2 pr-2 transition-colors ${selected ? "bg-best-soft" : "hover:bg-paper-2"}`}
    >
      {/* gutter: id + thread line */}
      <div className="flex flex-col items-center pt-1">
        <span className={`font-mono text-[11px] tabular ${item.decision?.newBest ? "font-semibold text-best" : selected ? "text-ink" : "text-ink-3"}`}>{item.id}</span>
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${v ? v.dot : "bg-best"}`} aria-hidden>
          {!v && <span className="block size-2 animate-ping rounded-full bg-best opacity-60" />}
        </span>
        <span className="mt-1.5 w-px flex-1 bg-rule" aria-hidden />
      </div>

      <div className="min-w-0 space-y-2.5">
        {/* agent: the idea */}
        <div>
          <Speaker who="agent">
            <span className="font-normal normal-case tracking-normal">· idea{item.parentId ? ` on ${item.parentId}` : ""}</span>
          </Speaker>
          <div className="rounded-2xl rounded-tl-md border border-rule bg-paper-2 px-3.5 py-2.5">
            <p className="text-[15px] leading-snug font-medium text-ink">
              <Typed text={item.idea.title} play={enter && live} cps={90} />
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[11px] tracking-wide text-ink-3">{CATEGORY_LABEL[item.idea.category] ?? item.idea.category}</span>
              {item.idea.radical && <RadicalBadge />}
            </div>
            {item.idea.rationale && (
              <p className={`mt-1.5 text-[13px] leading-relaxed text-ink-2 ${selected ? "" : "line-clamp-3"}`}>
                <Typed text={item.idea.rationale} play={enter && live} cps={260} />
              </p>
            )}
          </div>
        </div>

        {/* sandbox */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink-3">sandbox</span>
          <div className="min-w-0">
            {item.llmCalls > 0 && (
              <p className="mb-1 text-[11.5px] text-ink-3">
                {item.llmCalls} LLM call{item.llmCalls === 1 ? "" : "s"} · {fmtCost(item.costUsd)}
              </p>
            )}
            {fails.map((a) => (
              <Enter key={a.attempt} className="mb-1.5">
                <details className="group/err rounded-lg border border-crash/30 bg-[var(--del-bg)] px-3 py-1.5 text-[12.5px]" onClick={(e) => e.stopPropagation()}>
                  <summary className="cursor-pointer list-none text-crash marker:hidden">
                    attempt {a.attempt + 1} failed · <span className="font-mono">{a.errorKind ?? "error"}</span>
                    {a.attempt + 1 < item.attempts.length || (!item.decision && item.attempts.at(-1) === a) ? (
                      <span className="text-ink-3"> — the agent repairs the code</span>
                    ) : null}
                    <span className="ml-1 text-ink-3 group-open/err:hidden">· show tail</span>
                  </summary>
                  {a.errorTail && (
                    <pre className="mt-1.5 max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
                      {a.errorTail.split("\n").slice(-8).join("\n")}
                    </pre>
                  )}
                </details>
              </Enter>
            ))}
            {item.stage === "running" && <Running repairing={fails.length > 0} />}
            {item.scored && (
              <Enter>
                <p className="font-mono text-[12.5px] text-ink tabular">
                  CV {formatScore(metric, item.scored.cvMean)} <span className="text-ink-3">± {formatSe(item.scored.cvSe)}</span>
                  <span className="text-ink-3"> · </span>select {formatScore(metric, item.scored.select)}
                  {okAttempt && <span className="text-ink-3"> · {fmtDuration(okAttempt.durationS)}</span>}
                  {okAttempt && okAttempt.attempt > 0 && <span className="text-keep"> · repaired</span>}
                </p>
              </Enter>
            )}
            {!item.scored && item.decision?.verdict === "crash" && <p className="text-[12.5px] text-crash">No score — every attempt failed.</p>}
          </div>
        </div>

        {/* gate */}
        {item.decision && v && (
          <Enter delay={0.05}>
            <div className={`rounded-2xl rounded-tl-md border px-3.5 py-2.5 ${v.box}`}>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink-3">gate</span>
                <span className={`flex items-center gap-1.5 text-sm font-semibold ${v.text}`}>
                  {item.decision.verdict === "crash" ? (
                    <span aria-hidden className="font-mono">
                      {v.icon}
                    </span>
                  ) : (
                    <Balance tip={item.decision.verdict === "keep"} />
                  )}
                  {v.label}
                </span>
                {item.decision.gate.label && <span className="text-[12.5px] text-ink-2">{item.decision.gate.label}</span>}
                {item.decision.gate.gainSe != null && (
                  <Chip>
                    {item.decision.gate.gainSe >= 0 ? "+" : "−"}
                    {Math.abs(item.decision.gate.gainSe).toFixed(2)} SE
                  </Chip>
                )}
                {item.decision.gate.p != null && <Chip>p = {fmtP(item.decision.gate.p)}</Chip>}
                {item.decision.newBest && item.index > 0 && <span className="text-[12px] font-semibold text-best">★ new best</span>}
              </p>
              <p className={`mt-1 text-[12px] leading-snug text-ink-2 ${selected ? "" : "line-clamp-2"}`}>{item.decision.reason || "(no reason recorded)"}</p>
            </div>
          </Enter>
        )}
      </div>
    </motion.article>
  );
}

/**
 * The gate as a tiny two-pan balance (02-direction: "A's best idea survives"): the new probe (left pan) is weighed
 * against the current best (right pan), and the beam tips only when the gate keeps it.
 */
function Balance({ tip }: { tip: boolean }) {
  const enter = useEnter();
  return (
    <svg viewBox="0 0 16 13" className="terra-balance h-[13px] w-4" data-tip={tip ? "keep" : "level"} data-enter={enter} aria-hidden>
      <path d="M8 5.2v6.3M5.5 12h5" stroke="currentColor" strokeOpacity=".55" strokeWidth="1.1" strokeLinecap="round" />
      <g className="terra-balance-beam">
        <path d="M1.5 5h13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M0.8 5.6 2 8.2 3.2 5.6" fill="none" stroke="currentColor" strokeOpacity=".7" strokeWidth=".9" strokeLinejoin="round" />
        <path d="M12.8 5.6 14 8.2 15.2 5.6" fill="none" stroke="currentColor" strokeOpacity=".7" strokeWidth=".9" strokeLinejoin="round" />
        <circle cx="2" cy="7.4" r="1.25" fill="currentColor" />
      </g>
      <circle cx="8" cy="5" r=".9" fill="currentColor" />
    </svg>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md bg-paper-3/80 px-1.5 py-px font-mono text-[11px] text-ink-2 tabular">{children}</span>;
}

function fmtP(p: number): string {
  if (p < 0.001) return "<0.001";
  return p >= 0.1 ? p.toFixed(2) : p.toFixed(3);
}

function Running({ repairing }: { repairing: boolean }) {
  const reduced = useReducedMotion();
  return (
    <div className="flex items-center gap-3">
      <span className="text-[12.5px] text-ink-2">{repairing ? "re-running the repaired code…" : "running in sandbox · repeated k-fold CV…"}</span>
      <span className="relative h-1 w-24 overflow-hidden rounded-full bg-paper-3" aria-hidden>
        {!reduced && (
          <motion.span
            className="absolute inset-y-0 w-1/2 rounded-full bg-gradient-to-r from-transparent via-best/70 to-transparent"
            initial={{ x: "-100%" }}
            animate={{ x: "200%" }}
            transition={{ duration: 1.25, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </span>
    </div>
  );
}
