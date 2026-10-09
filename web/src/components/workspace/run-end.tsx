"use client";

import { createContext, useContext, useState } from "react";
import type { ChatItem } from "@/lib/chat";
import { runEndView } from "@/lib/run-failure";

/** What the session offers a run that didn't finish (provided by SessionView around the chat). */
export interface RunEndActions {
  /** "url" | "file" for a run of this session, null if unknown. */
  sourceOf: (runId: string) => "url" | "file" | null;
  /** Start the same run again (same link, column, metric, experiments, format) in this session; resolves to an
   *  error message, or null once started. */
  retry: (runId: string) => Promise<string | null>;
  /** Re-open the setup pane with the run's link, so the column or metric can be changed. */
  edit: (runId: string) => void;
  /** Only the session's latest run offers the actions, and only while nothing else is running. */
  enabled: (runId: string) => boolean;
}

export const RunEndActionsCtx = createContext<RunEndActions | null>(null);

type RunEnd = Extract<ChatItem, { kind: "run_end" }>;

/** The body of a failed / cancelled / timed-out run's closing card: plain message, hint, Retry and Edit setup. */
export function RunEndCard({ it }: { it: RunEnd }) {
  const actions = useContext(RunEndActionsCtx);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = runEndView({ ...it, source: actions?.sourceOf(it.runId) ?? null });
  const live = !!actions && actions.enabled(it.runId);

  const retry = async () => {
    if (!actions || busy) return;
    setBusy(true);
    setError(null);
    const err = await actions.retry(it.runId);
    setBusy(false);
    if (err) setError(err);
  };

  const retryBtn = (primary: boolean) => (
    <button key="retry" type="button" onClick={retry} disabled={busy} className={primary ? "ws-start" : "ws-link text-[14px]"} data-run-retry>
      {busy ? "Starting…" : "Retry"}
      {primary && <span aria-hidden>→</span>}
    </button>
  );
  const editBtn = (primary: boolean) => (
    <button
      key="edit"
      type="button"
      onClick={() => actions?.edit(it.runId)}
      disabled={busy}
      className={primary ? "ws-start" : "ws-link text-[14px]"}
      data-run-edit
    >
      Edit setup
      {primary && <span aria-hidden>→</span>}
    </button>
  );
  const buttons = live
    ? v.primary === "edit"
      ? [v.edit && editBtn(true), v.retry && retryBtn(false)]
      : [v.retry && retryBtn(true), v.edit && editBtn(false)]
    : [];

  return (
    <div data-run-end={it.status} data-error-code={it.errorCode ?? undefined}>
      <p className={`ws-label ${it.status === "failed" ? "text-[var(--crash)]" : ""}`}>{v.label}</p>
      {v.title && <p className="ws-card-title">{v.title}</p>}
      <p className="ws-card-text">{v.text}</p>
      {v.hint && <p className="ws-card-text text-[var(--lp-ink-3)]">{v.hint}</p>}
      {live && buttons.some(Boolean) && <div className="mt-4 mb-1 flex flex-wrap items-center gap-x-5 gap-y-2">{buttons}</div>}
      {live && v.note && <p className="ws-card-text text-[13px] text-[var(--lp-ink-3)]">{v.note}</p>}
      {error && (
        <p role="alert" className="ws-card-text text-[13.5px] text-[var(--crash)]">
          {error}
        </p>
      )}
    </div>
  );
}
