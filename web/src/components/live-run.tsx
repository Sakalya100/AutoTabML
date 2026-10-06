"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PublicRunMeta } from "@/lib/api";
import { coerceEvent, type AnyEvent } from "@/lib/events";
import { fmtCost, fmtInt } from "@/lib/format";
import { buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { RunView } from "./run-view";

const TERMINAL = ["finished", "failed", "cancelled"];

export function LiveRun({ id }: { id: string }) {
  const [meta, setMeta] = useState<PublicRunMeta | null>(null);
  const [events, setEvents] = useState<AnyEvent[]>([]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const lastSeq = useRef(-1);

  const addEvents = (incoming: AnyEvent[]) => {
    const fresh = incoming.filter((e) => e.seq > lastSeq.current);
    if (!fresh.length) return;
    lastSeq.current = fresh[fresh.length - 1].seq;
    setEvents((prev) => [...prev, ...fresh]);
  };

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    const refresh = async () => {
      const res = await fetch(`/api/runs/${id}`, { cache: "no-store" });
      if (!res.ok) {
        setError(res.status === 404 ? "This run doesn't exist, or it has expired (runs are kept for 24 hours)." : "Could not load this run.");
        return null;
      }
      const body = (await res.json()) as {
        meta: PublicRunMeta;
        events: AnyEvent[];
        record: RunRecord | null;
      };
      if (cancelled) return null;
      setMeta(body.meta);
      addEvents(body.events);
      if (body.record) setRecord(body.record);
      return body.meta;
    };

    (async () => {
      const m = await refresh();
      if (!m || cancelled || TERMINAL.includes(m.status)) return;
      es = new EventSource(`/api/runs/${id}/stream?after=${lastSeq.current}`);
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false); // EventSource reconnects by itself with Last-Event-ID
      es.onmessage = (msg) => {
        try {
          const ev = coerceEvent(JSON.parse(msg.data));
          if (ev) addEvents([ev]);
        } catch {}
      };
      es.addEventListener("meta", (msg) => {
        try {
          setMeta(JSON.parse((msg as MessageEvent).data) as PublicRunMeta);
        } catch {}
      });
      es.addEventListener("end", () => {
        es?.close();
        setConnected(false);
        void refresh(); // pick up run.json (code + diffs) and the final status
      });
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [id]);

  const view = useMemo(() => buildView(events, record), [events, record]);

  if (error)
    return (
      <main className="mx-auto max-w-[720px] px-4 py-20 sm:px-6">
        <h1 className="font-display text-4xl">Run not found</h1>
        <p className="mt-3 text-ink-2">{error}</p>
        <p className="mt-6 flex gap-4 text-sm">
          <Link href="/new" className="underline underline-offset-4">
            Start a new run
          </Link>
          <Link href="/replays" className="underline underline-offset-4">
            Watch a replay
          </Link>
        </p>
      </main>
    );

  if (!meta)
    return (
      <main className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6">
        <div className="h-10 w-2/3 animate-pulse rounded bg-paper-2" />
        <div className="mt-8 h-[360px] animate-pulse rounded-md bg-paper-2" />
      </main>
    );

  const active = !TERMINAL.includes(meta.status);
  const cancel = async () => {
    setCancelling(true);
    try {
      const res = await fetch(`/api/runs/${id}/cancel`, { method: "POST" });
      const body = (await res.json()) as { meta?: PublicRunMeta };
      if (body.meta) setMeta(body.meta);
    } finally {
      setCancelling(false);
    }
  };

  const bar = (
    <div className="mt-6 space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border border-rule bg-paper-2 px-4 py-3 text-sm">
        <span className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${active ? "animate-pulse bg-best" : meta.status === "finished" ? "bg-keep" : "bg-crash"}`} aria-hidden />
          <span className="font-medium capitalize">{statusText(meta.status)}</span>
          {active && <span className="text-xs text-ink-3">{connected ? "live" : "connecting…"}</span>}
        </span>
        {view.current && (
          <span className="min-w-0 truncate text-ink-2">
            now: <span className="font-mono text-xs">{view.current.id}</span> {view.current.idea.title}
          </span>
        )}
        <span className="font-mono text-xs text-ink-2 tabular" title="LLM spend so far (heuristic runs cost nothing)">
          {fmtCost(view.totalCostUsd)} · {fmtInt(view.totalInputTokens + view.totalOutputTokens)} tok
        </span>
        <span className="text-xs text-ink-3">
          {meta.fileName} · {meta.llm === "heuristic" ? "offline heuristic" : "Anthropic"} · up to {meta.maxExperiments} experiments
        </span>
        {active && (
          <button
            onClick={cancel}
            disabled={cancelling}
            className="ml-auto rounded-full border border-crash/50 px-3 py-1 text-xs font-medium text-crash transition-colors hover:bg-crash/10 disabled:opacity-50"
          >
            {cancelling ? "Cancelling…" : "Cancel run"}
          </button>
        )}
      </div>
      {meta.status === "failed" && (
        <div className="rounded-md border border-crash/40 p-4">
          <p className="font-medium text-crash">{meta.error ?? "The run failed."}</p>
          {meta.errorTail && (
            <pre className="mt-3 max-h-72 overflow-auto rounded bg-code p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">{meta.errorTail}</pre>
          )}
        </div>
      )}
      {meta.status === "cancelled" && <p className="text-sm text-ink-3">This run was cancelled. Everything recorded up to that point is shown below.</p>}
    </div>
  );

  return (
    <RunView
      mode="live"
      events={events}
      record={record}
      title={meta.description ? meta.description : `Predicting ${meta.target}`}
      subtitle={
        <span className="text-sm">
          {meta.fileName} · target <span className="font-mono">{meta.target}</span>
        </span>
      }
      liveBar={bar}
      active={active}
      endedAs={meta.status === "cancelled" || meta.status === "failed" ? meta.status : null}
      emptyHint={meta.runner === "vercel-sandbox" ? "Creating a sandbox and installing the engine — a minute or two" : "Starting the engine and profiling your data"}
      plannedExperiments={meta.maxExperiments}
    />
  );
}

function statusText(s: PublicRunMeta["status"]): string {
  return {
    queued: "queued",
    starting: "starting",
    running: "running",
    finished: "finished",
    failed: "failed",
    cancelled: "cancelled",
  }[s];
}
