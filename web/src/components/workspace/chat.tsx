"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createContext, Fragment, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { chatSignature, type ChatExperiment, type ChatItem, type ChatStep, type ChatTask } from "@/lib/chat";
import { roleDoing, roleLabel } from "@/lib/feed";
import { fmtCost, fmtDuration, fmtInt } from "@/lib/format";
import { describeGap, formatScore, formatSe, metricInfo } from "@/lib/metrics";
import type { Metric } from "@/lib/schema";
import { answerKind, plainIdea, stopPhrase } from "@/lib/story";
import { CodeView, DiffView } from "../code-view";
import { AssetsCard } from "./assets";

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

/** The middle panel: a Task card, one card per experiment (its agent steps), then the stop, locked test, report, assets. */
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
    case "phase":
      return (
        <Enter className="ws-phase">
          {it.label}
          {it.count > 1 && <span className="tabular-nums"> · {it.count}</span>}
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
      return <TaskCard it={it} />;
    case "step":
      return (
        <Enter className="ws-card">
          <StepLines steps={[it.step]} />
          <DetailsFooter steps={[it.step]} />
        </Enter>
      );
    case "experiment": {
      const key = `${it.runId}:${it.id}`;
      return <ExperimentCard x={it} metric={metric} selected={selected === key} onSelect={() => onSelect(it.runId, it.id)} dataKey={key} />;
    }
    case "steer_ack":
      return (
        <Enter className="ws-ack">
          <p className="ws-label text-[var(--lp-signal)]">Steer applied{it.atExp ? ` · from ${it.atExp}` : ""}</p>
          <p className="mt-1 font-display text-[1.15rem] leading-snug text-[var(--lp-ink)] italic">“{it.text}”</p>
          <p className="mt-1 text-[13.5px] text-[var(--lp-ink-3)]">Every later Planner and Tuner prompt includes this. The frozen evaluation doesn’t change.</p>
        </Enter>
      );
    case "stopped": {
      const phrase = stopPhrase(it.reason);
      return (
        <Enter className="ws-card">
          <p className="ws-label">Stopped</p>
          <p className="ws-card-title">{phrase ? `It ${phrase}.` : "It stopped."}</p>
          <p className="ws-card-text">
            {it.reason === "user" ? "It finished the experiment in flight; next it scores the best model once on the locked test." : it.summary}
          </p>
        </Enter>
      );
    }
    case "final":
      return (
        <Enter className="ws-card">
          <p className="ws-label">Locked test</p>
          <p className="ws-card-title">
            <span className="font-mono text-[1.35rem] tracking-tight text-[var(--lp-signal)] tabular-nums">{formatScore(metric, it.test)}</span>{" "}
            <span className="text-[var(--lp-ink-2)]">on data it never saw.</span>
          </p>
          <p className="ws-card-text">
            {it.gap > 0 ? "A little below its own estimate" : it.gap < 0 ? "Better than its own estimate" : "Exactly its own estimate"}:{" "}
            {describeGap(metric, it.gap)}.
          </p>
          <dl className="ws-row-facts">
            <Fact k="dev CV" v={formatScore(metric, it.devCvMean)} />
            <Fact k="select" v={formatScore(metric, it.select)} />
            <Fact k="best" v={it.bestId} />
            <Fact k="experiments" v={String(it.nExperiments)} />
            <Fact k="time" v={fmtDuration(it.wallTimeS)} />
            <Fact k="cost" v={fmtCost(it.costUsd)} />
          </dl>
        </Enter>
      );
    case "report":
      return <ReportCard it={it} />;
    case "assets":
      return (
        <Enter>
          <AssetsCard it={it} metric={metric} />
        </Enter>
      );
    case "run_end":
      return (
        <Enter className="ws-card">
          <p className={`ws-label ${it.status === "failed" ? "text-[var(--crash)]" : ""}`}>
            {it.status === "failed" ? "The run failed" : it.status === "timed_out" ? "Timed out" : "Cancelled"}
          </p>
          <p className="ws-card-text">
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

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function TaskCard({ it }: { it: ChatTask }) {
  const m = metricInfo(it.metric);
  const kind = answerKind(it.problemType, null);
  const facts = [
    it.nRows != null && `${it.nRows.toLocaleString("en-US")} rows`,
    it.nCols != null && `${Math.max(0, it.nCols - 1)} features`,
    it.metric && m.label,
    it.metric && (m.greaterIsBetter ? "higher is better" : "lower is better"),
    it.maxExperiments && `up to ${it.maxExperiments} experiments`,
  ].filter(Boolean) as string[];
  return (
    <Enter className="ws-card ws-task">
      <p className="ws-label">Task</p>
      <p className="ws-task-goal">
        {it.target ? (
          <>
            Predict <span className="italic">{it.target}</span>
            {kind && <span className="text-[var(--lp-ink-3)]"> ({kind})</span>}
          </>
        ) : (
          <span className="text-[var(--lp-ink-3)] italic">Reading the data…</span>
        )}
      </p>
      {it.description && <p className="ws-card-text">{it.description}</p>}
      {facts.length > 0 && (
        <p className="ws-task-facts">
          {facts.map((f, i) => (
            <Fragment key={f}>
              {i > 0 && <span aria-hidden> · </span>}
              <span className="whitespace-nowrap">{f}</span>
            </Fragment>
          ))}
        </p>
      )}
      {it.warnings.length > 0 && (
        <p className="ws-task-warn" title={it.warnings.join("\n")}>
          {it.warnings.slice(0, 3).join(" · ")}
        </p>
      )}
      {it.steps.length > 0 && <StepLines steps={it.steps} />}
      <DetailsFooter steps={it.steps} />
    </Enter>
  );
}

const VERDICT: Record<string, { word: string; cls: string }> = {
  keep: { word: "Kept", cls: "text-[var(--lp-signal)]" },
  discard: { word: "Not kept", cls: "text-[var(--lp-ink-3)]" },
  crash: { word: "Broke", cls: "text-[var(--crash)]" },
};

function ExperimentCard({
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
  const active = [...x.steps].reverse().find((s) => s.status === "running");
  const idea = x.idea ? cap(plainIdea(x.idea)) : null;
  return (
    <motion.article
      data-key={dataKey}
      initial={enter ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
      aria-current={selected || undefined}
      className={`ws-card ws-x ${selected ? "ws-x-selected" : ""}`}
    >
      <button type="button" onClick={onSelect} className="ws-x-head" aria-label={`Experiment ${x.index + 1}: show it on the map`}>
        <span
          className={`ws-dot ${running ? "ws-dot-run" : x.decision?.verdict === "keep" ? "ws-dot-keep" : x.decision?.verdict === "crash" ? "ws-dot-crash" : "ws-dot-drop"}`}
          aria-hidden
        />
        <span className="ws-x-id">{x.id}</span>
        <span className="ws-x-idea" title={x.idea?.title}>
          {idea ?? <span className="text-[var(--lp-ink-3)] italic">Choosing what to try…</span>}
        </span>
        <span className="ws-x-verdict">
          {running ? (
            <span className="ws-x-running">Running…{active && <span className="text-[var(--lp-ink-3)]"> · {roleLabel(active.role)}</span>}</span>
          ) : (
            v && (
              <>
                <span className={v.cls}>
                  {v.word}
                  {x.decision!.newBest && x.index > 0 && (
                    <span aria-label=", new best" className="ml-1">
                      ▲
                    </span>
                  )}
                </span>
                {x.scored && (
                  <span className={`ws-x-score ${x.decision!.verdict === "keep" ? "text-[var(--lp-ink)]" : ""}`}>{formatScore(metric, x.scored.cvMean)}</span>
                )}
              </>
            )
          )}
        </span>
      </button>
      {x.steps.length > 0 && <StepLines steps={x.steps} />}
      <DetailsFooter steps={x.steps} x={x} metric={metric} />
    </motion.article>
  );
}

/** One line per agent step: the role in a fixed column, the step's plain one-line summary (full text on hover). */
function StepLines({ steps }: { steps: ChatStep[] }) {
  return (
    <ol className="ws-lines" aria-label="Agent steps">
      {steps.map((s, i) => {
        const running = s.status === "running";
        const text = running ? `${roleDoing(s.role)}…` : s.plain || (s.status === "error" ? (s.error?.split("\n")[0] ?? "Failed.") : "Done.");
        return (
          <li key={s.stepId || i} className="ws-line">
            <span className={`ws-line-role ${running ? "ws-role-run" : s.status === "error" ? "text-[var(--crash)]" : ""}`}>
              {roleLabel(s.role)}
              {s.attempt > 0 ? ` ${s.attempt + 1}` : ""}
            </span>
            <span
              className={`ws-line-text ${running ? "text-[var(--lp-ink-3)] italic" : s.status === "error" ? "text-[var(--crash)]" : ""}`}
              title={text.length > 60 ? text : undefined}
            >
              {text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ---- the Details disclosure: one per card, bottom-left, tabs for what exists ------------------------------ */

type TabId = "reasoning" | "code" | "output" | "gate";

function DetailsFooter({ steps, x, metric }: { steps: ChatStep[]; x?: ChatExperiment; metric?: Metric | null }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabId | null>(null);
  const uid = useId();
  const reasoning = steps.filter((s) => s.reasoning || s.inputSummary);
  const codeStep = [...steps].reverse().find((s) => s.diff) ?? [...steps].reverse().find((s) => s.code);
  const outputs = steps.filter((s) => s.stdoutTail || s.stderrTail || s.error);
  const hasOutput = outputs.length > 0 || (x && (x.logs.length > 0 || x.hpoTrials > 0 || x.attempts.some((a) => !a.ok)));
  const usage = steps.filter((s) => s.model || s.tokensIn || s.tokensOut || s.durationS);
  const hasGate = !!x?.decision || !!x?.scored || usage.length > 0;
  const tabs: { id: TabId; label: string }[] = [];
  if (reasoning.length) tabs.push({ id: "reasoning", label: "Reasoning" });
  if (codeStep) tabs.push({ id: "code", label: codeStep.diff ? "Diff" : "Code" });
  if (hasOutput) tabs.push({ id: "output", label: "Output" });
  if (hasGate) tabs.push({ id: "gate", label: x ? "Gate" : "Usage" });
  if (!tabs.length) return null;
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  const panelId = `${uid}-panel`;
  const tabId = (t: TabId) => `${uid}-tab-${t}`;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = tabs.findIndex((t) => tabId(t.id) === e.currentTarget.id);
    const i = at >= 0 ? at : tabs.findIndex((t) => t.id === current.id);
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    setTab(tabs[n].id);
    document.getElementById(tabId(tabs[n].id))?.focus();
  };

  return (
    <div className="ws-foot">
      <button type="button" className="ws-disc" aria-expanded={open} aria-controls={open ? `${uid}-details` : undefined} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 12 12" className="ws-disc-chev" aria-hidden>
          <path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Details
        <span className="ws-disc-list">{tabs.map((t) => t.label).join(" · ")}</span>
      </button>
      {open && (
        <div id={`${uid}-details`} className="ws-dpanel">
          {tabs.length > 1 && (
            <div role="tablist" aria-label="Details" className="ws-dtabs">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  id={tabId(t.id)}
                  type="button"
                  role="tab"
                  aria-selected={t.id === current.id}
                  aria-controls={panelId}
                  tabIndex={t.id === current.id ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  onKeyDown={onKey}
                  className="ws-dtab"
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <div
            id={panelId}
            role={tabs.length > 1 ? "tabpanel" : undefined}
            aria-labelledby={tabs.length > 1 ? tabId(current.id) : undefined}
            className="ws-dbody"
          >
            {current.id === "reasoning" && <ReasoningTab steps={reasoning} />}
            {current.id === "code" && codeStep && <CodeTab step={codeStep} />}
            {current.id === "output" && <OutputTab steps={outputs} x={x} />}
            {current.id === "gate" && <GateTab steps={usage} x={x} metric={metric ?? null} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ReasoningTab({ steps }: { steps: ChatStep[] }) {
  return (
    <div className="space-y-4">
      {steps.map((s, i) => (
        <section key={s.stepId || i}>
          <p className="ws-label">{roleLabel(s.role)}</p>
          {s.inputSummary && <p className="ws-given">Given: {s.inputSummary}</p>}
          {s.reasoning && <p className="ws-reason">{s.reasoning.slice(-3000)}</p>}
        </section>
      ))}
    </div>
  );
}

function CodeTab({ step }: { step: ChatStep }) {
  return (
    <div>
      <p className="ws-label mb-2">
        {roleLabel(step.role)} · {step.diff ? "changes from the parent experiment" : "the experiment's code"}
      </p>
      {step.diff ? <DiffView diff={step.diff} /> : <CodeView code={step.code ?? ""} />}
    </div>
  );
}

function OutputTab({ steps, x }: { steps: ChatStep[]; x?: ChatExperiment }) {
  const failed = x?.attempts.filter((a) => !a.ok) ?? [];
  return (
    <div className="space-y-4">
      {x && (x.hpoTrials > 0 || failed.length > 0) && (
        <p className="ws-given">
          {[
            x.hpoTrials > 0 && `${x.hpoTrials} tuning trial${x.hpoTrials === 1 ? "" : "s"} ran in the sandbox`,
            failed.length > 0 &&
              `${failed.length} sandbox attempt${failed.length === 1 ? "" : "s"} failed (${failed.map((a) => a.errorKind ?? "error").join(", ")})`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {steps.map((s, i) => (
        <section key={s.stepId || i}>
          <p className="ws-label">{roleLabel(s.role)} · sandbox output (tail)</p>
          {(s.stdoutTail || s.stderrTail) && <pre className="ws-pre">{[s.stdoutTail, s.stderrTail].filter(Boolean).join("\n")}</pre>}
          {s.error && <pre className="ws-pre text-[var(--crash)]">{s.error.slice(-800)}</pre>}
        </section>
      ))}
      {x && x.logs.length > 0 && (
        <section>
          <p className="ws-label">Sandbox log · last {Math.min(x.logs.length, 40)} lines</p>
          <pre className="ws-pre">{x.logs.slice(-40).join("\n")}</pre>
        </section>
      )}
    </div>
  );
}

function GateTab({ steps, x, metric }: { steps: ChatStep[]; x?: ChatExperiment; metric: Metric | null }) {
  const g = x?.decision?.gate;
  return (
    <div className="space-y-4">
      {x && (x.scored || x.decision) && (
        <section>
          <dl className="ws-row-facts mt-0">
            {x.scored && <Fact k="CV" v={`${formatScore(metric, x.scored.cvMean)} ± ${formatSe(x.scored.cvSe)}`} />}
            {g?.gainSe != null && <Fact k="gain" v={`${g.gainSe >= 0 ? "+" : "−"}${Math.abs(g.gainSe).toFixed(2)} SE`} />}
            {g?.p != null && <Fact k="p-value" v={g.p < 0.001 ? "<0.001" : g.p.toFixed(3)} />}
            {x.decision && <Fact k="best so far" v={`${x.decision.bestId} · ${formatScore(metric, x.decision.bestMean)}`} />}
          </dl>
          {x.decision?.reason && <p className="ws-gate-reason">{x.decision.reason}</p>}
        </section>
      )}
      {steps.length > 0 && (
        <div className="ws-usage-wrap">
          <table className="ws-usage">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col" className="ws-usage-model">
                  Model
                </th>
                <th scope="col" className="text-right">
                  Tokens
                </th>
                <th scope="col" className="text-right">
                  Cost
                </th>
                <th scope="col" className="text-right">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) => (
                <tr key={s.stepId || i}>
                  <td>{roleLabel(s.role)}</td>
                  <td className="ws-usage-model" title={s.model ? `${s.provider ? `${s.provider}/` : ""}${s.model}` : undefined}>
                    {s.model ?? "—"}
                  </td>
                  <td className="text-right" title={s.tokensCached ? `${fmtInt(s.tokensCached)} cached` : undefined}>
                    {s.tokensIn || s.tokensOut ? `${fmtInt(s.tokensIn)} / ${fmtInt(s.tokensOut)}` : "—"}
                  </td>
                  <td className="text-right">{s.model ? fmtCost(s.costUsd) : "—"}</td>
                  <td className="text-right">{s.durationS > 0 ? fmtDuration(s.durationS) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ReportCard({ it }: { it: Extract<ChatItem, { kind: "report" }> }) {
  const list = (title: string, xs: string[]) =>
    xs.length > 0 && (
      <div className="mt-4">
        <p className="ws-label">{title}</p>
        <ul className="mt-1.5 space-y-1 text-[14.5px] leading-relaxed text-[var(--lp-ink-2)]">
          {xs.map((x, i) => (
            <li key={i} className="grid grid-cols-[1rem_minmax(0,1fr)]">
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
    <Enter className="ws-card ws-report">
      <p className="ws-label">Report</p>
      <p className="ws-card-title ws-report-title">{it.plain ?? "What it found"}</p>
      {it.summary && <p className="ws-card-text">{it.summary}</p>}
      {list("What worked", it.whatWorked)}
      {list("Caveats", it.caveats)}
      {list("Next steps", it.nextSteps)}
      {it.notes.length > 0 && list("Notes from the run", it.notes)}
      {it.faithful === false && <p className="ws-given mt-4">Some numbers the Reporter quoted were corrected against the run record.</p>}
    </Enter>
  );
}
