"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { TERMINAL as TERMINAL_STATUSES, type PublicRunMeta } from "@/lib/api-types";
import { buildChat, type ChatMessageInput } from "@/lib/chat";
import { isStopCommand, MAX_STEER_CHARS, splitLink } from "@/lib/chat-input";
import { coerceEvent, type AnyEvent } from "@/lib/events";
import { activeAgentStep, roleDoing } from "@/lib/feed";
import { EQUIV_NOTE, equivCost, fmtCost, fmtInt } from "@/lib/format";
import { EXAMPLES } from "@/lib/ingest/examples";
import { formatScore, metricInfo } from "@/lib/metrics";
import { buildView } from "@/lib/run-state";
import type { MessageRow, SessionPayload } from "@/lib/session-types";
import type { Metric } from "@/lib/schema";
import { plainIdea } from "@/lib/story";
import { SurveyPanel } from "../survey-panel";
import { ChatLog } from "./chat";
import { SetupPane, useRunDraft } from "./draft";
import { SignInPrompt, useSignedIn } from "../auth";
import { useShell } from "./shell";
import { ContourField, RevealTitle } from "./fx/hero";
import { Num, ScrambleIn, spotlight } from "./fx/motion";
import { gsap } from "@/lib/motion/gsap";

const TERMINAL = new Set<string>(TERMINAL_STATUSES);
const EASE = [0.16, 1, 0.3, 1] as const;

interface Props {
  /** null = /s/new: an empty session that exists once its first run starts. */
  sessionId: string | null;
  maxExperiments: number;
  liveEnabled: boolean;
}

type Sel = { runId: string; expId: string } | null;

const toInput = (m: MessageRow): ChatMessageInput => ({
  id: m.id,
  role: m.role,
  text: m.text,
  kind: m.kind,
  created_at: m.created_at,
});

export function SessionView({ sessionId, maxExperiments, liveEnabled }: Props) {
  const router = useRouter();
  const { tab, setTab, refreshSessions, renameLocal } = useShell();
  const [payload, setPayload] = useState<SessionPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, AnyEvent[]>>({});
  const [metas, setMetas] = useState<Record<string, PublicRunMeta>>({});
  const [messages, setMessages] = useState<ChatMessageInput[]>([]);
  const [sel, setSel] = useState<Sel>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef<Record<string, number>>({});
  const draft = useRunDraft(maxExperiments);
  const auth = useSignedIn();
  const signedOut = auth.loaded && !auth.signedIn;

  /* ---- load (and reload) the whole session from Postgres ---------------------------------------------- */
  const load = useCallback(async () => {
    if (!sessionId || !auth.loaded || !auth.signedIn) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        cache: "no-store",
      });
      const body = (await res.json()) as SessionPayload & { error?: string };
      if (!res.ok) {
        setLoadError(body.error ?? "Couldn't load this session.");
        return;
      }
      setLoadError(null);
      setPayload(body);
      setMessages((prev) => [...body.messages.map(toInput), ...prev.filter((m) => m.pending)]);
      setEvents((prev) => {
        const next = { ...prev };
        for (const r of body.runs) {
          // Keep whatever the live stream already delivered beyond what Postgres has.
          const have = prev[r.row.id] ?? [];
          const merged = new Map<number, AnyEvent>();
          for (const e of r.events) merged.set(e.seq, e);
          for (const e of have) merged.set(e.seq, e);
          next[r.row.id] = [...merged.values()].sort((a, b) => a.seq - b.seq);
          lastSeq.current[r.row.id] = next[r.row.id].at(-1)?.seq ?? -1;
        }
        return next;
      });
      setMetas((prev) => {
        const next = { ...prev };
        for (const r of body.runs) if (r.meta) next[r.row.id] = r.meta;
        return next;
      });
    } catch {
      setLoadError("Couldn't reach the server. Check your connection; this page retries when you reload it.");
    }
  }, [sessionId, auth.loaded, auth.signedIn]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load of external data
    void load();
  }, [load, auth.userId]);

  const runs = payload?.runs ?? [];
  const statusOf = (id: string) => metas[id]?.status ?? runs.find((r) => r.row.id === id)?.row.status ?? null;
  const activeRun = [...runs].reverse().find((r) => !TERMINAL.has(statusOf(r.row.id) ?? "finished")) ?? null;
  const activeId = activeRun?.row.id ?? null;

  /* ---- live tail of the running run (SSE resumes after the last seq we hold) ------------------------- */
  useEffect(() => {
    if (!activeId) return;
    const es = new EventSource(`/api/runs/${activeId}/stream?after=${lastSeq.current[activeId] ?? -1}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const ev = coerceEvent(JSON.parse(msg.data));
        if (!ev || ev.seq <= (lastSeq.current[activeId] ?? -1)) return;
        lastSeq.current[activeId] = ev.seq;
        setEvents((prev) => ({
          ...prev,
          [activeId]: [...(prev[activeId] ?? []), ev],
        }));
      } catch {}
    };
    es.addEventListener("meta", (msg) => {
      try {
        const m = JSON.parse((msg as MessageEvent).data) as PublicRunMeta;
        setMetas((prev) => ({ ...prev, [m.id]: m }));
      } catch {}
    });
    es.addEventListener("end", () => {
      es.close();
      setConnected(false);
      void load();
      refreshSessions();
    });
    return () => {
      es.close();
      setConnected(false);
    };
  }, [activeId, load, refreshSessions]);

  /* ---- derived: chat items, map view ----------------------------------------------------------------- */
  const items = buildChat(
    runs.map((r) => {
      const m = metas[r.row.id];
      return {
        id: r.row.id,
        events: events[r.row.id] ?? [],
        status: m?.status ?? r.row.status,
        error: m?.error ?? null,
        finishedAt: m?.finishedAt ?? r.row.finished_at,
      };
    }),
    messages,
  );
  const mapRunId = sel?.runId ?? runs.at(-1)?.row.id ?? null;
  const mapEvents = mapRunId ? (events[mapRunId] ?? []) : [];
  const view = buildView(mapEvents);
  const mapActive = !!mapRunId && mapRunId === activeId;
  const metric = view.metric;

  const activeEvents = activeId ? events[activeId] : undefined;
  const typing = (() => {
    if (!activeId) return null;
    const st = statusOf(activeId);
    const act = activeAgentStep(activeEvents ?? []);
    if (act) return `${roleDoing(act.role)}…`;
    if (!activeEvents?.length) return st === "queued" || st === "starting" ? "Starting the engine and downloading your data…" : "Reading your data…";
    const last = activeEvents.at(-1)?.type;
    if (last === "stopped") return "Scoring the best model once on the locked test…";
    if (last === "run_finished") return "Writing the report…";
    if (last === "report_ready") return null;
    return "Thinking about the next step…";
  })();

  const stopRequested =
    !!activeId && messages.some((m) => m.kind === "control" && m.role === "user" && Date.parse(m.created_at) >= Date.parse(activeRun?.row.created_at ?? "0"));
  /** The engine has decided to stop (on its own or when asked): only the locked test and the report are left. */
  const finishing = !!activeEvents?.some((e) => e.type === "stopped");

  /* ---- selection sync ------------------------------------------------------------------------------- */
  const onChatSelect = (runId: string, expId: string) => setSel((s) => (s && s.runId === runId && s.expId === expId ? null : { runId, expId }));
  const onMapSelect = (expId: string) => {
    if (!mapRunId) return;
    setSel({ runId: mapRunId, expId });
    setFocusKey((k) => k + 1);
  };
  const selectedKey = sel ? `${sel.runId}:${sel.expId}` : null;
  const selectedExp = sel && sel.runId === mapRunId ? view.experiments.find((x) => x.id === sel.expId) : undefined;

  /* ---- composer actions ----------------------------------------------------------------------------- */
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async (raw: string, kind?: "stop") => {
    const t = raw.trim();
    setComposerError(null);
    if (!kind && !t) return;
    // No run in flight: the paste-a-link flow.
    if (!activeId && !kind) {
      const { url, rest } = splitLink(t);
      if (url) {
        // Setting up the run takes over the chat pane until Start (or "Use different data").
        setText("");
        void draft.previewLink(url, rest);
        return;
      }
      if (!sessionId) {
        setComposerError("Paste a link to a public CSV to begin, or attach a file.");
        return;
      }
    }
    if (!sessionId) return;
    const stop = kind === "stop" || (!!activeId && isStopCommand(t));
    const pending: ChatMessageInput = {
      id: `pending-${Date.now()}`,
      role: "user",
      text: stop ? t || "Stop" : t.slice(0, MAX_STEER_CHARS),
      kind: stop ? "control" : activeId ? "steer" : "chat",
      created_at: new Date().toISOString(),
      pending: true,
    };
    setMessages((m) => [...m, pending]);
    setText("");
    setSending(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stop && !t ? { kind: "stop" } : stop ? { kind: "stop", text: t } : { text: t }),
      });
      const body = (await res.json()) as {
        messages?: MessageRow[];
        error?: string;
      };
      if (!res.ok || !body.messages) {
        setMessages((m) => m.filter((x) => x.id !== pending.id));
        setText(t);
        setComposerError(body.error ?? "Couldn't send that. Try again.");
        return;
      }
      setMessages((m) => [...m.filter((x) => x.id !== pending.id), ...body.messages!.map(toInput)]);
      if (stop) void load();
    } catch {
      setMessages((m) => m.filter((x) => x.id !== pending.id));
      setText(t);
      setComposerError("Couldn't reach the server. Your message wasn't sent.");
    } finally {
      setSending(false);
    }
  };

  const cancelNow = async () => {
    if (!activeId) return;
    await fetch(`/api/runs/${activeId}/cancel`, { method: "POST" }).catch(() => null);
    void load();
  };

  const setupRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  /** The hand-off: the setup pane folds up and away before the chat (and the run's first card) takes the pane. */
  const foldSetup = () =>
    new Promise<void>((resolve) => {
      const parts = setupRef.current?.querySelectorAll<HTMLElement>(".su-pane > *");
      if (reduced || !parts?.length) return resolve();
      gsap.to([...parts].reverse(), {
        y: -14,
        opacity: 0,
        filter: "blur(4px)",
        duration: 0.42,
        ease: "power2.in",
        stagger: 0.035,
        onComplete: () => resolve(),
      });
    });

  const startRun = async () => {
    const res = await draft.start(sessionId);
    if (!res) return;
    if (!res.sessionId) {
      router.push(`/runs/${res.id}`);
      return;
    }
    await foldSetup();
    refreshSessions();
    if (res.sessionId !== sessionId) router.replace(`/s/${res.sessionId}`);
    else {
      draft.done();
      await load();
    }
  };

  /** A link or file is being read or set up: the setup form takes over the chat pane until Start. */
  const settingUp = !activeId && draft.state.status !== "idle";

  /* ---- render ---------------------------------------------------------------------------------------- */
  const title = payload?.session.title ?? (sessionId ? "" : "New session");
  /** An existing session whose history hasn't arrived yet: say so instead of "No runs yet" / "Start a run". */
  const loading = !!sessionId && !payload && !loadError && !signedOut;
  const activeStatus = activeId ? statusOf(activeId) : null;
  const decided = view.experiments.filter((x) => x.status !== "running").length;
  const best = view.experiments.find((x) => x.id === view.bestId);
  const planned = runs.find((r) => r.row.id === mapRunId)?.row.max_experiments ?? null;

  if (loadError && !payload)
    return (
      <div className="ws-main">
        <div className="ws-empty">
          <p className="ws-kicker">Session</p>
          <p className="mt-3 font-display text-[2rem] leading-tight">This session isn’t here.</p>
          <p className="mt-2 max-w-[46ch] text-[14px] text-[var(--lp-ink-2)]">
            {loadError} {auth.enabled ? "Sessions belong to the account that started them." : "Sessions belong to the browser that started them."}
          </p>
          <Link href="/s/new" className="ws-start mt-6 inline-flex">
            Start a new session <span aria-hidden>→</span>
          </Link>
        </div>
      </div>
    );

  return (
    <div className="ws-main" data-tab={tab}>
      <section className="ws-chat" aria-label="Chat">
        <header className="ws-chat-head">
          <TitleEditor
            sessionId={sessionId}
            title={title}
            onRenamed={(t) => {
              if (sessionId) renameLocal(sessionId, t);
              setPayload((p) => (p ? { ...p, session: { ...p.session, title: t } } : p));
            }}
          />
          <p className="ws-chat-status">
            {activeId ? (
              <>
                <span className="ws-live-dot" aria-hidden />
                {activeStatus === "running"
                  ? view.current
                    ? `Experiment ${view.current.index + 1}${planned ? ` of ${planned}` : ""}`
                    : "Working"
                  : "Starting"}
                {stopRequested && " · stopping"}
                {!connected && " · reconnecting…"}
              </>
            ) : loading ? (
              "Loading…"
            ) : runs.length ? (
              `${runs.length} run${runs.length === 1 ? "" : "s"}`
            ) : (
              "No runs yet"
            )}
          </p>
        </header>
        {signedOut ? (
          <div className="su-scroll ws-thread">
            <SignInPrompt title={sessionId ? "Sign in to see this session." : "Sign in to start a run."} />
          </div>
        ) : loading ? (
          <div className="ws-thread ws-loading" aria-busy="true" aria-label="Loading the session">
            {[0, 1, 2].map((i) => (
              <div key={i} className="ws-skel" style={{ animationDelay: `${i * 120}ms` }}>
                <span className="ws-skel-line w-[42%]" />
                <span className="ws-skel-line w-[88%]" />
                <span className="ws-skel-line w-[64%]" />
              </div>
            ))}
          </div>
        ) : settingUp ? (
          <div className="su-scroll" ref={setupRef} data-lenis-prevent>
            <SetupPane key={draft.state.source?.kind === "link" ? draft.state.source.url : "file"} draft={draft} onStart={startRun} />
          </div>
        ) : (
          <>
            <ChatLog
              items={items}
              metricOf={(runId) => {
                const started = events[runId]?.find((e) => e.type === "run_started") as { profile?: { metric?: Metric } } | undefined;
                return started?.profile?.metric ?? null;
              }}
              selected={selectedKey}
              focusKey={focusKey}
              onSelect={onChatSelect}
              typing={typing}
              tail={null}
              empty={sessionId ? null : <EmptyNew onExample={(u) => void send(u)} disabled={!liveEnabled} />}
            />
            <Composer
              mode={activeId ? "run" : "draft"}
              text={text}
              setText={setText}
              onSend={() => void send(text)}
              onStop={() => void send("", "stop")}
              onCancelNow={cancelNow}
              onAttach={() => fileRef.current?.click()}
              sending={sending}
              stopRequested={stopRequested || finishing}
              finishing={finishing}
              disabled={!liveEnabled && !activeId}
              error={composerError}
            />
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              void draft.previewFile(f, text.trim());
              setText("");
            }
            e.target.value = "";
          }}
        />
      </section>

      <section className="ws-map" aria-label="Live map">
        <header className="ws-map-head">
          <p className="ws-kicker">
            {mapActive ? "Live map" : "Map"}
            {runs.length > 1 && mapRunId ? ` · run ${runs.findIndex((r) => r.row.id === mapRunId) + 1} of ${runs.length}` : ""}
          </p>
          {mapRunId && (
            <dl className="ws-facts">
              <div>
                <dt>tried</dt>
                <dd>
                  <Num value={decided} format={(v) => String(Math.round(v))} animate={mapActive} duration={0.6} />
                  {planned ? <span className="text-[var(--lp-ink-3)]">/{planned}</span> : null}
                </dd>
              </div>
              <div>
                <dt>best {metricInfo(metric).label}</dt>
                <dd className="text-[var(--lp-signal)]">
                  <Num value={best?.cv?.mean} format={(v) => formatScore(metric, v)} mode="scramble" animate={mapActive} className="ws-fact-best" />
                </dd>
              </div>
              <div>
                <dt>tokens</dt>
                <dd>
                  <Num value={view.totalInputTokens + view.totalOutputTokens} format={(v) => fmtInt(Math.round(v))} animate={mapActive} />
                </dd>
              </div>
              <div title={EQUIV_NOTE}>
                <dt>cost ≈</dt>
                <dd>
                  <Num value={equivCost(view.totalInputTokens, view.totalOutputTokens)} format={fmtCost} animate={mapActive} />
                </dd>
              </div>
            </dl>
          )}
        </header>
        <div className="ws-map-body">
          {mapRunId && mapEvents.length > 0 ? (
            <SurveyPanel view={view} selectedId={sel?.expId ?? null} onSelect={onMapSelect} staging={mapActive} compact bare heightClass="h-full" />
          ) : (
            <div className="ws-map-empty" data-waiting={activeId ? "" : undefined}>
              <ContourField visibleOnPhone={tab === "map"} busy={settingUp || !!activeId} />
              <p className="ws-map-empty-text max-w-[30ch] text-[14px] leading-relaxed text-[var(--lp-ink-3)]">
                {loading
                  ? "Loading the map…"
                  : activeId
                    ? "The land appears with the first experiment. One position per experiment; the ball climbs when a change is kept."
                    : "Each experiment becomes one position on this map. Start a run to see it climb."}
              </p>
            </div>
          )}
          <div className="ws-map-overlay">
            <AnimatePresence mode="wait" initial={false}>
              {selectedExp ? (
                <motion.div
                  key={selectedExp.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22, ease: EASE }}
                  className="ws-map-pick"
                >
                  <p className="font-mono text-[12.5px] text-[var(--lp-ink-3)]">
                    {selectedExp.id} ·{" "}
                    {selectedExp.status === "keep" ? (
                      <span className="text-[var(--lp-signal)]">kept</span>
                    ) : selectedExp.status === "running" ? (
                      "running"
                    ) : selectedExp.status === "crash" ? (
                      "broke"
                    ) : (
                      "not kept"
                    )}
                    {selectedExp.cv && ` · CV ${formatScore(metric, selectedExp.cv.mean)}`}
                  </p>
                  <p className="mt-0.5 truncate text-[13.5px] text-[var(--lp-ink)]">{plainIdea(selectedExp.idea)}</p>
                  <button
                    type="button"
                    className="ws-link mt-1 text-[13px]"
                    onClick={() => {
                      setTab("chat");
                      setFocusKey((k) => k + 1);
                    }}
                  >
                    Show in chat
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ---- pieces ------------------------------------------------------------------------------------------- */

const at = (i: number) => ({ "--i": i }) as CSSProperties;

function EmptyNew({ onExample, disabled }: { onExample: (url: string) => void; disabled: boolean }) {
  return (
    <div className="ws-empty ws-hero">
      <p className="ws-kicker fx-rise" style={at(0)}>
        <ScrambleIn text="New session" chars="upperCase" duration={1} />
      </p>
      <RevealTitle className="ws-hero-title mt-4 font-display text-[clamp(2.2rem,4.4vw,3.4rem)] leading-[1.02] tracking-[-0.01em]">
        Paste a link.
        <br />
        Press <span className="ws-hero-start text-[var(--lp-signal)] italic">Start.</span>
      </RevealTitle>
      <p className="fx-rise mt-4 max-w-[46ch] text-[15px] leading-relaxed text-[var(--lp-ink-2)]" style={at(4)}>
        A team of agents plans, writes and tests models on your table, keeps only the gains that are real, and stops when the gains are noise. You can steer
        them while they work.
      </p>
      {disabled ? (
        <p className="fx-rise mt-6 text-[14px] text-[var(--lp-ink-3)]" style={at(5)}>
          Live runs are switched off on this deployment. Watch a replay instead.
        </p>
      ) : (
        <div className="mt-7 flex flex-wrap items-center gap-2" onPointerMove={spotlight}>
          <span className="fx-rise mr-1 text-[13px] text-[var(--lp-ink-3)]" style={at(5)}>
            No data at hand? Try
          </span>
          {EXAMPLES.map((ex, i) => (
            <button
              key={ex.url}
              type="button"
              className="nr-example ws-chip fx-rise"
              data-spot
              style={at(6 + i)}
              onClick={() => onExample(ex.url)}
              title={ex.url}
            >
              {ex.name} <span className="text-[var(--lp-ink-3)]">· {ex.blurb}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TitleEditor({ sessionId, title, onRenamed }: { sessionId: string | null; title: string; onRenamed: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const t = value.replace(/\s+/g, " ").trim();
    setEditing(false);
    if (!sessionId || !t || t === title) return setValue(title);
    onRenamed(t);
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t }),
    }).catch(() => null);
    if (!res?.ok) {
      onRenamed(title);
      setValue(title);
      setError("Couldn't rename it. Try again.");
    } else setError(null);
  };
  if (editing)
    return (
      <input
        autoFocus
        aria-label="Session name"
        value={value}
        maxLength={80}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setValue(title);
            setEditing(false);
          }
        }}
        className="ws-title ws-title-input"
      />
    );
  return (
    <div className="min-w-0">
      <button
        type="button"
        className="ws-title"
        disabled={!sessionId}
        title={sessionId ? "Rename" : undefined}
        onClick={() => {
          setValue(title);
          setEditing(true);
        }}
      >
        <span className="truncate">{title || " "}</span>
        {sessionId && (
          <svg viewBox="0 0 16 16" className="ws-title-pen" aria-hidden>
            <path d="M3 11.5V13h1.5l7-7L10 4.5l-7 7ZM11 3.5l1.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {error && <p className="text-[13px] text-[var(--crash)]">{error}</p>}
    </div>
  );
}

function Composer(p: {
  mode: "run" | "draft";
  text: string;
  setText: (t: string) => void;
  onSend: () => void;
  onStop: () => void;
  onCancelNow: () => void;
  onAttach: () => void;
  sending: boolean;
  stopRequested: boolean;
  finishing: boolean;
  disabled: boolean;
  error: string | null;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grow with the text, up to ~5 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [p.text]);
  const run = p.mode === "run";
  const looksLikeStop = run && isStopCommand(p.text);
  return (
    <div className="ws-composer">
      <div className="ws-composer-box" data-run={run || undefined}>
        {!run && (
          <button
            type="button"
            onClick={p.onAttach}
            className="ws-attach"
            aria-label="Attach a CSV file"
            title="Attach a CSV (up to 5 MB)"
            disabled={p.disabled}
          >
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
              <path
                d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={p.text}
          disabled={p.disabled}
          onChange={(e) => p.setText(e.target.value)}
          onPaste={(e) => {
            if (run) return;
            const pasted = e.clipboardData.getData("text").trim();
            // A pasted link previews at once (the Phase-2 "paste, Start" flow).
            if (/^https?:\/\/\S+$/i.test(pasted) && !p.text.trim()) {
              e.preventDefault();
              p.setText(pasted);
              setTimeout(() => p.onSend(), 0);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              p.onSend();
            }
          }}
          placeholder={run ? "Steer the agents…" : "Paste a link to a CSV, and say what to predict (optional)"}
          aria-label={run ? "Message the agents" : "Link to a CSV"}
          className="ws-input"
        />
        <button
          type="button"
          onClick={p.onSend}
          disabled={p.sending || !p.text.trim() || p.disabled}
          className="ws-send"
          aria-label={looksLikeStop ? "Stop the run" : "Send"}
        >
          {looksLikeStop ? "Stop" : "Send"}
        </button>
        {run && (
          <button
            type="button"
            onClick={p.onStop}
            disabled={p.stopRequested || p.sending}
            className="ws-stop"
            title="Finish the current experiment, score the locked test once, write the report"
          >
            <span className="ws-stop-square" aria-hidden />
            {p.finishing ? "Finishing…" : p.stopRequested ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      <p className="ws-hint">
        {p.error ? (
          <span className="text-[var(--crash)]" role="alert">
            {p.error}
          </span>
        ) : run ? (
          p.finishing ? (
            <>The agents have stopped. Scoring the best model once on the locked test, then the report.</>
          ) : p.stopRequested ? (
            <>
              Finishing the current experiment, then the locked test and the report.{" "}
              <button type="button" className="ws-link" onClick={p.onCancelNow}>
                Cancel now instead
              </button>
            </>
          ) : (
            <>
              Steer in plain words, e.g. “prefer simple linear models”; it goes into the next Planner prompt. “stop” finishes gracefully: the locked test and
              report still run.
            </>
          )
        ) : (
          <>Public https links: GitHub, Google Sheets &amp; Drive, Hugging Face, Dropbox. Or attach a CSV.</>
        )}
      </p>
    </div>
  );
}
