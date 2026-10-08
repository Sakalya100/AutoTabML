"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { TERMINAL, type PublicRunMeta } from "@/lib/api-types";
import { coerceEvent, type AnyEvent } from "@/lib/events";
import { fmtCost, fmtInt } from "@/lib/format";
import { buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { RunView } from "./run-view";

export function LiveRun({ id }: { id: string }) {
  const [meta, setMeta] = useState<PublicRunMeta | null>(null);
  const [events, setEvents] = useState<AnyEvent[]>([]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const lastSeq = useRef(-1);
  const router = useRouter();

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
        setError(res.status === 404 ? "This run doesn't exist in this browser." : "Could not load this run.");
        return null;
      }
      const body = (await res.json()) as {
        meta: PublicRunMeta;
        events: AnyEvent[];
        record: RunRecord | null;
      };
      if (cancelled) return null;
      if (body.meta.sessionId) {
        // Runs open in their session's workspace.
        router.replace(`/s/${body.meta.sessionId}`);
        return null;
      }
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
  }, [id, router]);

  const view = useMemo(() => buildView(events, record), [events, record]);

  if (error)
    return (
      <main data-terra className="mx-auto max-w-[720px] px-4 py-20 sm:px-6">
        <h1 className="font-display text-4xl">Run not found</h1>
        <p className="mt-3 text-ink-2">{error}</p>
        <p className="mt-6 flex gap-4 text-sm">
          <Link href="/s/new" className="underline underline-offset-4">
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
      <main data-terra className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6">
        <div className="h-10 w-2/3 animate-pulse rounded bg-paper-2" />
        <div className="terra-frame mt-8 h-[clamp(360px,62vh,640px)] animate-pulse rounded-xl" />
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
    <div className="space-y-3 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[12px] text-ink-3">
        <span className="flex items-center gap-2">
          <span className={`size-1.5 rounded-full ${active ? "animate-pulse bg-best" : meta.status === "finished" ? "bg-best" : "bg-crash"}`} aria-hidden />
          <span className="text-ink">{statusText(meta.status)}</span>
          {active && <span>{connected ? "· live" : "· connecting…"}</span>}
        </span>
        <span className="tabular" title="LLM spend so far (free-tier models cost nothing)">
          {fmtCost(view.totalCostUsd)} · {fmtInt(view.totalInputTokens + view.totalOutputTokens)} tokens
        </span>
        <span>
          {meta.engine === "agentic" || !meta.llm ? "agents on free Groq / Gemini models" : meta.llm === "heuristic" ? "no LLM: built-in search" : "ideas by Claude"} · up to{" "}
          {meta.maxExperiments} experiments
        </span>
        {active && (
          <button
            onClick={cancel}
            disabled={cancelling}
            className="ml-auto rounded-full border border-crash/50 px-3 py-1 font-sans text-xs text-crash transition-colors hover:bg-crash/10 disabled:opacity-50"
          >
            {cancelling ? "Cancelling…" : "Cancel run"}
          </button>
        )}
      </div>
      {meta.status === "failed" && (
        <div className="border-l border-crash/60 pl-4">
          <p className="text-crash">{meta.error ?? "The run failed."}</p>
          {meta.errorTail && (
            <pre className="mt-3 max-h-72 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-3">{meta.errorTail}</pre>
          )}
        </div>
      )}
      {meta.status === "finished" && meta.error && <p className="text-sm text-ink-3">{meta.error}</p>}
      {meta.status === "cancelled" && <p className="text-sm text-ink-3">This run was cancelled. Everything recorded up to then is below.</p>}
      {meta.status === "timed_out" && <p className="text-sm text-ink-3">{meta.error ?? "This run timed out."} Everything recorded up to then is below.</p>}
    </div>
  );

  return (
    <RunView
      mode="live"
      events={events}
      record={record}
      title={meta.description ? meta.description : `Predicting ${meta.target}`}
      kicker={`Your run · ${meta.fileName}`}
      liveBar={bar}
      active={active}
      endedAs={meta.status === "cancelled" || meta.status === "failed" || meta.status === "timed_out" ? meta.status : null}
      emptyHint={meta.runner === "sandbox" ? "Creating a sandbox and installing the engine — a minute or two" : meta.source === "url" ? "Downloading your data and starting the agents" : "Starting the engine and profiling your data"}
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
    timed_out: "timed out",
  }[s];
}
