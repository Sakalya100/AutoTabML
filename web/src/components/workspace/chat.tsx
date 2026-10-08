"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { chatSignature, type ChatExperiment, type ChatItem, type ChatStep, type ChatTask } from "@/lib/chat";
import { roleDoing, roleLabel } from "@/lib/feed";
import { fmtCost, fmtDuration, fmtInt } from "@/lib/format";
import { describeGap, formatScore, formatSe, metricInfo } from "@/lib/metrics";
import type { Metric } from "@/lib/schema";
import { answerKind, plainIdea, stopPhrase } from "@/lib/story";
import { CodeView, DiffView } from "../code-view";

const EASE = [0.22, 1, 0.36, 1] as const;

/** True once the chat has mounted: messages that arrive after that animate in; a loaded backlog does not. */
const ReadyCtx = createContext(false);
function useEnterAnim() {
  const ready = useContext(ReadyCtx);
  const reduced = useReducedMotion();
  const [animate] = useState(ready && !reduced);
  return animate;
}

function Enter({ children, className }: { children: ReactNode; className?: string }) {
  const animate = useEnterAnim();
  return (
    <motion.div
      className={className}
      initial={animate ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.36, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

interface Props {
  items: ChatItem[];
  /** Each run's metric (scores are stored oriented; formatting needs the metric). */
  metricOf: (runId: string) => Metric | null;
  /** Experiment selected on the map or in the chat (`runId:expId`). */
  selected: string | null;
  /** Bumped when the map picks an experiment: scroll it into view. */
  focusKey: number;
  onSelect: (runId: string, expId: string) => void;
  /** A run is producing events: show the typing line. */
  typing: string | null;
  /** Rendered after the items (the draft card of a pasted link). */
  tail?: ReactNode;
  empty?: ReactNode;
}

/** The middle panel: every agent step as a message, grouped per experiment, with stage dividers. */
export function ChatLog({ items, metricOf, selected, focusKey, onSelect, typing, tail, empty }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastTop = useRef(0);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const [ready, setReady] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    const r = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const sig = `${chatSignature(items)}|${typing ?? ""}|${tail ? "t" : ""}`;
  // Follow the newest message unless the reader scrolled up; then count it as unseen (the pill says "new").
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (follow.current)
      el.scrollTo({
        top: el.scrollHeight,
        behavior: ready && !reduced ? "smooth" : "auto",
      });
    else setUnseen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // The map picked an experiment: bring its message into view.
  useEffect(() => {
    if (!focusKey || !selected) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(selected)}"]`);
    if (!el) return;
    follow.current = false;
    setFollowing(false);
    el.scrollIntoView({
      block: "center",
      behavior: reduced ? "auto" : "smooth",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    if (atBottom) {
      follow.current = true;
      setFollowing(true);
      setUnseen(false);
    } else if (el.scrollTop < lastTop.current - 2) {
      follow.current = false;
      setFollowing(false);
    }
    lastTop.current = el.scrollTop;
  };
  const jump = () => {
    follow.current = true;
    setFollowing(true);
    setUnseen(false);
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: reduced ? "auto" : "smooth",
    });
  };

  return (
    <ReadyCtx.Provider value={ready}>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="ws-scroll" role="log" aria-live="polite" aria-relevant="additions" aria-label="Agent chat">
          <div className="ws-thread">
            {items.length === 0 && !tail && empty}
            {items.map((it) => (
              <Item key={it.key} it={it} metric={"runId" in it ? metricOf(it.runId) : null} selected={selected} onSelect={onSelect} />
            ))}
            {tail}
            <AnimatePresence initial={false}>
              {typing && (
                <motion.div
                  key="typing"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                  transition={{ duration: 0.28, ease: EASE }}
                  className="ws-typing"
                >
                  <span className="flex gap-1" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="size-1 rounded-full bg-[var(--lp-ink-3)]"
                        animate={reduced ? undefined : { opacity: [0.25, 1, 0.25] }}
                        transition={{
                          duration: 1.2,
                          repeat: Infinity,
                          delay: i * 0.18,
                          ease: "easeInOut",
                        }}
                      />
                    ))}
                  </span>
                  {typing}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        <AnimatePresence>
          {!following && (
            <motion.button
              key="jump"
              type="button"
              onClick={jump}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
              transition={{ duration: 0.22, ease: EASE }}
              className="ws-jump"
            >
              <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
                <path d="M6 2v7M2.5 6 6 9.5 9.5 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {unseen ? "New messages" : "Jump to latest"}
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </ReadyCtx.Provider>
  );
}

function Item({ it, metric, selected, onSelect }: { it: ChatItem; metric: Metric | null; selected: string | null; onSelect: Props["onSelect"] }) {
  switch (it.kind) {
    case "divider":
      return (
        <Enter className="ws-divider">
          <span>{it.label}</span>
        </Enter>
      );
    case "user":
      return (
        <Enter className="ws-user-row">
          <div className={`ws-user ${it.pending ? "opacity-60" : ""}`}>
            {it.msgKind !== "chat" && <p className="ws-user-kind">{it.msgKind === "steer" ? "Steer" : "Control"}</p>}
            <p className="whitespace-pre-wrap break-words">{it.text}</p>
          </div>
        </Enter>
      );
    case "system":
      return (
        <Enter className="ws-system">
          <p className={it.tone === "warn" ? "text-[var(--lp-ink-2)]" : ""}>{it.text}</p>
        </Enter>
      );
    case "task":
      return <TaskMsg it={it} />;
    case "step":
      return (
        <Enter className="ws-agent">
          <StepRow step={it.step} solo />
        </Enter>
      );
    case "experiment": {
      const key = `${it.runId}:${it.id}`;
      return <ExperimentMsg x={it} metric={metric} selected={selected === key} onSelect={() => onSelect(it.runId, it.id)} dataKey={key} />;
    }
    case "steer_ack":
      return (
        <Enter className="ws-ack">
          <p className="ws-kicker text-[var(--lp-signal)]">Steer applied{it.atExp ? ` · from ${it.atExp}` : ""}</p>
          <p className="mt-1 font-display text-[1.15rem] leading-snug text-[var(--lp-ink)] italic">“{it.text}”</p>
          <p className="mt-1 text-[13.5px] text-[var(--lp-ink-3)]">Every later Planner and Tuner prompt includes this. The frozen evaluation doesn’t change.</p>
        </Enter>
      );
    case "stopped": {
      const phrase = stopPhrase(it.reason);
      return (
        <Enter className="ws-moment">
          <p className="ws-kicker text-[var(--lp-signal)]">It stopped</p>
          <p className="ws-moment-title">{phrase ? `It ${phrase}.` : "It stopped."}</p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--lp-ink-2)]">
            {it.reason === "user" ? "It finished the experiment in flight; next it scores the best model once on the locked test." : it.summary}
          </p>
        </Enter>
      );
    }
    case "final":
      return (
        <Enter className="ws-moment">
          <p className="ws-kicker text-[var(--lp-signal)]">The locked test</p>
          <p className="ws-moment-title">
            <span className="font-mono text-[1.5rem] tracking-tight tabular-nums">{formatScore(metric, it.test)}</span>{" "}
            <span className="text-[var(--lp-ink-2)]">on data it never saw.</span>
          </p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--lp-ink-2)]">
            {it.gap > 0 ? "A little below its own estimate" : it.gap < 0 ? "Better than its own estimate" : "Exactly its own estimate"}:{" "}
            {describeGap(metric, it.gap)}.
          </p>
          <dl className="ws-facts mt-3">
            <Fact k="dev CV" v={formatScore(metric, it.devCvMean)} />
            <Fact k="select" v={formatScore(metric, it.select)} />
            <Fact k="test" v={formatScore(metric, it.test)} signal />
            <Fact k="best" v={it.bestId} />
            <Fact k="experiments" v={String(it.nExperiments)} />
            <Fact k="time" v={fmtDuration(it.wallTimeS)} />
            <Fact k="cost" v={fmtCost(it.costUsd)} />
          </dl>
        </Enter>
      );
    case "report":
      return <ReportMsg it={it} />;
    case "run_end":
      return (
        <Enter className="ws-moment">
          <p className={`ws-kicker ${it.status === "failed" ? "text-[var(--crash)]" : ""}`}>
            {it.status === "failed" ? "The run failed" : it.status === "timed_out" ? "Timed out" : "Cancelled"}
          </p>
          <p className="mt-1 text-[14px] text-[var(--lp-ink-2)]">
            {it.error ??
              (it.status === "failed"
                ? "The engine stopped with an error."
                : it.status === "timed_out"
                  ? "The run timed out before the locked test; every experiment so far is kept."
                  : "The run was cancelled before the locked test.")}
          </p>
        </Enter>
      );
  }
}

function Fact({ k, v, signal }: { k: string; v: string; signal?: boolean }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className={signal ? "text-[var(--lp-signal)]" : ""}>{v}</dd>
    </div>
  );
}

function TaskMsg({ it }: { it: ChatTask }) {
  const m = metricInfo(it.metric);
  const kind = answerKind(it.problemType, null);
  return (
    <Enter className="ws-moment">
      <p className="ws-kicker">The task</p>
      <p className="ws-moment-title">
        Predict <span className="italic">{it.target ?? "the target"}</span>
        {kind && <span className="text-[var(--lp-ink-3)]"> ({kind})</span>}
      </p>
      <p className="mt-1.5 font-mono text-[13px] leading-relaxed text-[var(--lp-ink-3)] tabular-nums">
        {it.nRows != null && `${it.nRows.toLocaleString("en-US")} rows · `}
        {it.nCols != null && `${Math.max(0, it.nCols - 1)} features · `}
        {m.label} · {m.greaterIsBetter ? "higher is better" : "lower is better"}
        {it.maxExperiments ? ` · up to ${it.maxExperiments} experiments` : ""}
      </p>
      {it.warnings.length > 0 && <p className="mt-1 text-[13.5px] text-[var(--lp-ink-3)]">{it.warnings.slice(0, 2).join(" · ")}</p>}
    </Enter>
  );
}

const VERDICT: Record<string, { word: string; cls: string }> = {
  keep: { word: "Kept", cls: "text-[var(--lp-signal)]" },
  discard: { word: "Not kept", cls: "text-[var(--lp-ink-2)]" },
  crash: { word: "Broke", cls: "text-[var(--crash)]" },
};

function ExperimentMsg({
  x,
  metric,
  selected,
  onSelect,
  dataKey,
}: {
  x: ChatExperiment;
  metric: Metric | null;
  selected: boolean;
  onSelect: () => void;
  dataKey: string;
}) {
  const enter = useEnterAnim();
  const running = !x.decision;
  const v = x.decision ? VERDICT[x.decision.verdict] : null;
  const g = x.decision?.gate;
  return (
    <motion.article
      data-key={dataKey}
      initial={enter ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
      aria-current={selected || undefined}
      className={`ws-exp ${selected ? "ws-exp-selected" : ""}`}
    >
      <button type="button" onClick={onSelect} className="ws-exp-head" aria-label={`Experiment ${x.index + 1}: show it on the map`}>
        <span
          className={`ws-dot ${running ? "ws-dot-run" : x.decision?.verdict === "keep" ? "ws-dot-keep" : x.decision?.verdict === "crash" ? "ws-dot-crash" : "ws-dot-drop"}`}
          aria-hidden
        />
        <span className="font-mono text-[13px] text-[var(--lp-ink-3)] tabular-nums">{x.id}</span>
        <span className="min-w-0 flex-1 text-left text-[15.5px] leading-snug text-[var(--lp-ink)]">
          {x.idea ? (
            <>
              <span className="text-[var(--lp-ink-3)] italic">Tried </span>
              {plainIdea(x.idea)}
            </>
          ) : (
            <span className="text-[var(--lp-ink-3)] italic">Choosing what to try…</span>
          )}
        </span>
        <span className="ws-onmap" aria-hidden>
          {selected ? "on the map" : "show on map"}
        </span>
      </button>
      <ol className="ws-steps" aria-label="Agent steps">
        {x.steps.map((s, i) => (
          <li key={s.stepId || i}>
            <StepRow step={s} />
          </li>
        ))}
      </ol>
      {x.hpoTrials > 0 && <p className="ws-sub">{x.hpoTrials} tuning trials ran in the sandbox</p>}
      {x.logs.length > 0 && (
        <details className="ws-details ws-sub">
          <summary>
            <MorePill>sandbox log · last {Math.min(x.logs.length, 40)} lines</MorePill>
          </summary>
          <pre className="ws-pre">{x.logs.slice(-40).join("\n")}</pre>
        </details>
      )}
      {x.decision && v && (
        <div className="ws-verdict">
          <span className="ws-role">Gate</span>
          <span>
            <span className={`font-medium ${v.cls}`}>{v.word}</span>
            {x.decision.newBest && x.index > 0 && (
              <span className="ml-2 font-mono text-[13.5px] tracking-[0.14em] text-[var(--lp-signal)] uppercase">new best</span>
            )}
            <span className="ml-2 font-mono text-[13px] text-[var(--lp-ink-3)] tabular-nums">
              {x.scored && (
                <>
                  CV {formatScore(metric, x.scored.cvMean)} ± {formatSe(x.scored.cvSe)}
                </>
              )}
              {g?.gainSe != null && ` · ${g.gainSe >= 0 ? "+" : "−"}${Math.abs(g.gainSe).toFixed(2)} SE`}
              {g?.p != null && ` · p ${g.p < 0.001 ? "<0.001" : g.p.toFixed(3)}`}
            </span>
            {x.decision.reason && (
              <details className="ws-details mt-0.5">
                <summary>
                  <MorePill>Why this verdict</MorePill>
                </summary>
                <p className="mt-1 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--lp-ink-3)]">{x.decision.reason}</p>
              </details>
            )}
          </span>
        </div>
      )}
    </motion.article>
  );
}

/** One agent step: role label, plain first line; reasoning, code/diff, sandbox tail and tokens behind disclosure. */
function StepRow({ step, solo }: { step: ChatStep; solo?: boolean }) {
  const running = step.status === "running";
  const text = running ? `${roleDoing(step.role)}…` : step.plain || (step.status === "error" ? "Failed." : "Done.");
  const hasMore = !!(step.reasoning || step.code || step.diff || step.stdoutTail || step.stderrTail || step.error || step.model || step.inputSummary);
  // Name what the disclosure holds, so it reads as something to open ("reasoning · code"), not a stray glyph.
  const inside = [
    step.reasoning && "reasoning",
    step.diff ? "diff" : step.code ? "code" : null,
    (step.stdoutTail || step.stderrTail) && "output",
    step.error && "error",
  ].filter(Boolean) as string[];
  const label = (
    <>
      <span className={`ws-role ${running ? "ws-role-run" : step.status === "error" ? "ws-role-crash" : ""}`} title={step.model ?? undefined}>
        {roleLabel(step.role)}
        {step.attempt > 0 ? ` ${step.attempt + 1}` : ""}
      </span>
      <span
        className={`ws-plain ${running ? "text-[var(--lp-ink-3)] italic" : step.status === "error" ? "text-[var(--crash)]" : ""} ${solo ? "text-[15px]" : ""}`}
      >
        {text}
        {hasMore && !running && <MorePill>{inside.length ? inside.join(" · ") : "details"}</MorePill>}
      </span>
    </>
  );
  if (!hasMore) return <div className="ws-step">{label}</div>;
  return (
    <details className="ws-step-d">
      <summary className="ws-step">{label}</summary>
      <div className="ws-step-body">
        <p className="font-mono text-[13.5px] leading-relaxed text-[var(--lp-ink-3)] tabular-nums">
          {[
            step.model && `${step.provider ? `${step.provider}/` : ""}${step.model}`,
            (step.tokensIn || step.tokensOut) &&
              `${fmtInt(step.tokensIn)} in · ${fmtInt(step.tokensOut)} out${step.tokensCached ? ` · ${fmtInt(step.tokensCached)} cached` : ""}`,
            step.model && `${fmtCost(step.costUsd)}${step.wouldBeCostUsd > step.costUsd ? ` (list ${fmtCost(step.wouldBeCostUsd)})` : ""}`,
            step.durationS > 0 && fmtDuration(step.durationS),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {step.inputSummary && <p className="mt-1 text-[13.5px] text-[var(--lp-ink-3)]">Given: {step.inputSummary}</p>}
        {step.reasoning && (
          <Block title="Reasoning">
            <pre className="ws-pre whitespace-pre-wrap">{step.reasoning.slice(-3000)}</pre>
          </Block>
        )}
        {step.diff ? (
          <Block title="Diff">
            <DiffView diff={step.diff} />
          </Block>
        ) : step.code ? (
          <Block title="Code">
            <CodeView code={step.code} />
          </Block>
        ) : null}
        {(step.stdoutTail || step.stderrTail) && (
          <Block title="Sandbox output (tail)">
            <pre className="ws-pre">{[step.stdoutTail, step.stderrTail].filter(Boolean).join("\n")}</pre>
          </Block>
        )}
        {step.error && <p className="mt-2 font-mono text-[13px] whitespace-pre-wrap text-[var(--crash)]">{step.error.slice(-800)}</p>}
      </div>
    </details>
  );
}

/** The "open me" affordance for every disclosure in the trace: a labelled pill whose chevron turns when open. */
function MorePill({ children }: { children: ReactNode }) {
  return (
    <span className="ws-more">
      {children}
      <svg viewBox="0 0 12 12" className="ws-more-chev" aria-hidden>
        <path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-2.5">
      <p className="ws-kicker mb-1">{title}</p>
      {children}
    </div>
  );
}

function ReportMsg({ it }: { it: Extract<ChatItem, { kind: "report" }> }) {
  const list = (title: string, xs: string[]) =>
    xs.length > 0 && (
      <div className="mt-3">
        <p className="ws-kicker">{title}</p>
        <ul className="mt-1 space-y-1 text-[14px] leading-relaxed text-[var(--lp-ink-2)]">
          {xs.map((x, i) => (
            <li key={i} className="grid grid-cols-[0.9rem_minmax(0,1fr)]">
              <span aria-hidden className="text-[var(--lp-ink-3)]">
                –
              </span>
              <span>{x}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <Enter className="ws-moment ws-report">
      <p className="ws-kicker text-[var(--lp-signal)]">The report · Reporter</p>
      <p className="ws-moment-title">{it.plain ?? "What it found"}</p>
      {it.summary && <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--lp-ink-2)]">{it.summary}</p>}
      {list("What worked", it.whatWorked)}
      {list("Caveats", it.caveats)}
      {list("Next steps", it.nextSteps)}
      {it.notes.length > 0 && list("Notes from the run", it.notes)}
      {it.faithful === false && (
        <p className="mt-3 font-mono text-[13px] text-[var(--lp-ink-3)]">Some numbers the Reporter quoted were corrected against the run record.</p>
      )}
    </Enter>
  );
}
