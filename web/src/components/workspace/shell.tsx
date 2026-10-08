"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { formatScore } from "@/lib/metrics";
import { useSignedIn } from "../auth";
import type { SessionListItem } from "@/lib/session-types";

export type MobileTab = "chat" | "map" | "sessions";

interface ShellCtx {
  tab: MobileTab;
  setTab: (t: MobileTab) => void;
  refreshSessions: () => void;
  /** Optimistic title update after an inline rename. */
  renameLocal: (id: string, title: string) => void;
}

const Ctx = createContext<ShellCtx>({ tab: "chat", setTab: () => {}, refreshSessions: () => {}, renameLocal: () => {} });
export const useShell = () => useContext(Ctx);

const RUNNING = new Set(["queued", "starting", "running"]);

/** The workspace frame: sessions on the left (a tab on phones), the page (chat + map) beside it. */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const [tab, setTabState] = useState<MobileTab>("chat");
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const params = useParams<{ sessionId?: string }>();
  const current = params?.sessionId ?? null;
  const reqRef = useRef(0);
  const auth = useSignedIn();
  const signedOut = auth.loaded && !auth.signedIn;

  const refresh = useCallback(async () => {
    const id = ++reqRef.current;
    if (!auth.loaded || !auth.signedIn) return; // the list belongs to an account; nothing to fetch signed out
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      const body = (await res.json()) as { sessions?: SessionListItem[] };
      if (id !== reqRef.current) return;
      setUnavailable(!res.ok);
      setSessions(body.sessions ?? []);
    } catch {
      if (id === reqRef.current) setUnavailable(true);
    }
  }, [auth.loaded, auth.signedIn]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load of external data
    void refresh();
  }, [refresh, current, auth.userId]);

  // Poll while something runs (status dots and best scores move), slowly otherwise.
  const anyRunning = !!sessions?.some((s) => s.status && RUNNING.has(s.status));
  useEffect(() => {
    const t = setInterval(() => void refresh(), anyRunning ? 4000 : 30000);
    return () => clearInterval(t);
  }, [anyRunning, refresh]);

  const setTab = useCallback((t: MobileTab) => setTabState(t), []);
  const renameLocal = useCallback((id: string, title: string) => setSessions((xs) => xs?.map((s) => (s.id === id ? { ...s, title } : s)) ?? xs), []);

  return (
    <Ctx.Provider value={{ tab, setTab, refreshSessions: refresh, renameLocal }}>
      <div data-terra className="ws-root" data-tab={tab}>
        <MobileTabs />
        <aside className="ws-sessions" aria-label="Sessions">
          <div className="ws-sessions-head">
            <h2 className="ws-kicker">Sessions</h2>
            <Link href="/s/new" className="ws-new" onClick={() => setTabState("chat")}>
              <span aria-hidden>+</span> New
            </Link>
          </div>
          <nav className="ws-sessions-list">
            {signedOut && <p className="px-4 pt-3 text-[13.5px] leading-relaxed text-[var(--lp-ink-3)]">Sign in to see your sessions.</p>}
            {!signedOut && sessions === null && !unavailable && (
              <div className="space-y-3 px-4 pt-2" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-9 animate-pulse rounded bg-[rgb(var(--lp-ink-rgb,236_231_220)/0.04)]" />
                ))}
              </div>
            )}
            {!signedOut && unavailable && (
              <p className="px-4 pt-3 text-[13.5px] leading-relaxed text-[var(--lp-ink-3)]">Saved sessions are unavailable right now. Runs still work.</p>
            )}
            {!signedOut && sessions?.length === 0 && !unavailable && (
              <p className="px-4 pt-3 text-[13.5px] leading-relaxed text-[var(--lp-ink-3)]">
                Your runs will be listed here. {auth.enabled ? "They're saved to your account." : "They stay in this browser."}
              </p>
            )}
            <ul>
              <AnimatePresence initial={false}>
                {(signedOut ? [] : (sessions ?? [])).map((s) => (
                  <motion.li
                    key={s.id}
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                  >
                    <Link href={`/s/${s.id}`} onClick={() => setTabState("chat")} aria-current={s.id === current ? "page" : undefined} className="ws-session">
                      <span className={`ws-sdot ws-sdot-${s.status ?? "none"}`} aria-label={s.status ?? "no run"} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-[var(--lp-ink)]">{s.title}</span>
                        <span className="mt-0.5 flex items-baseline gap-2 font-mono text-[12px] text-[var(--lp-ink-3)] tabular-nums">
                          {s.best != null && <span className="text-[var(--lp-ink-2)]">{formatScore(s.metric, s.best)}</span>}
                          <span className="truncate">{s.fileName}</span>
                        </span>
                      </span>
                      <time className="shrink-0 font-mono text-[11.5px] text-[var(--lp-ink-3)]" dateTime={s.updatedAt}>
                        {relTime(s.updatedAt)}
                      </time>
                    </Link>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </nav>
        </aside>
        <div className="ws-page">{children}</div>
      </div>
    </Ctx.Provider>
  );
}

/** "now", "4m", "3h", "2d", then a date. */
export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Phone-only tab bar (Chat | Map | Sessions). */
export function MobileTabs() {
  const { tab, setTab } = useShell();
  const tabs: [MobileTab, string][] = [
    ["chat", "Chat"],
    ["map", "Map"],
    ["sessions", "Sessions"],
  ];
  return (
    <div className="ws-tabs" role="tablist" aria-label="Workspace">
      {tabs.map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="ws-tab">
          {label}
          {tab === k && <motion.span layoutId="ws-tab-ink" className="ws-tab-ink" transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }} />}
        </button>
      ))}
    </div>
  );
}
