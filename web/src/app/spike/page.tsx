"use client";

/**
 * SPIKE page: start an AutoTinker run on the FastAPI backend (/py/*), which runs it in a Vercel Sandbox, then poll
 * GET /py/runs/{id}?after=SEQ for events. Polling, not SSE, on purpose (spike); no styling effort.
 */
import { useEffect, useRef, useState } from "react";

type Ev = { seq: number; type: string; exp_id?: string; [k: string]: unknown };
type Run = { id: string; status: string; error?: string | null; error_tail?: string | null; timings?: Record<string, unknown> };

function summary(e: Ev): string {
  const pick: Record<string, unknown> = {};
  for (const k of ["decision", "reason", "ok", "attempt", "summary", "best_exp_id", "dev_cv_mean", "role", "provider", "model"]) {
    if (e[k] !== undefined && e[k] !== null) pick[k] = e[k];
  }
  const cv = e.cv as { mean?: number } | undefined;
  if (cv?.mean !== undefined) pick.cv_mean = cv.mean;
  const s = JSON.stringify(pick);
  return s.length > 220 ? s.slice(0, 220) + "…" : s;
}

export default function SpikePage() {
  const [url, setUrl] = useState("https://raw.githubusercontent.com/selva86/datasets/master/BreastCancer.csv");
  const [target, setTarget] = useState("Class");
  const [maxExp, setMaxExp] = useState(3);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [msg, setMsg] = useState("");
  const after = useRef(0);

  async function start() {
    setMsg("starting (sandbox create + engine install, ~15 s)…");
    setEvents([]);
    after.current = 0;
    const r = await fetch("/py/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, target, max_experiments: maxExp }),
    });
    const j = await r.json();
    if (!r.ok) return setMsg(`start failed: ${JSON.stringify(j)}`);
    setMsg(`started: ${JSON.stringify(j.timings)}`);
    setRunId(j.id);
  }

  async function stop(hard: boolean) {
    if (!runId) return;
    const r = await fetch(`/py/runs/${runId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hard }),
    });
    setMsg(`stop: ${JSON.stringify(await r.json())}`);
  }

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/py/runs/${runId}?after=${after.current}`, { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        setRun(j.run);
        if (j.events?.length) {
          after.current = j.next_after;
          setEvents((prev) => [...prev, ...j.events]);
        }
        if (["finished", "failed", "cancelled"].includes(j.run?.status)) return;
      } catch {
        /* transient; keep polling */
      }
      if (alive) setTimeout(tick, 1500);
    };
    tick();
    return () => {
      alive = false;
    };
  }, [runId]);

  return (
    <main style={{ padding: 16, fontFamily: "monospace", fontSize: 13 }}>
      <h1>AutoTinker sandbox spike</h1>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} size={70} aria-label="dataset url" />
        <input value={target} onChange={(e) => setTarget(e.target.value)} size={12} aria-label="target" />
        <input type="number" min={1} max={3} value={maxExp} onChange={(e) => setMaxExp(Number(e.target.value))} aria-label="max experiments" />
        <button onClick={start}>Start</button>
        <button onClick={() => stop(false)} disabled={!runId}>Stop</button>
        <button onClick={() => stop(true)} disabled={!runId}>Cancel (hard)</button>
      </div>
      <p>{msg}</p>
      {run && (
        <p>
          run <b>{run.id}</b> · status <b>{run.status}</b> {run.error ? `· ${run.error}` : ""}
          <br />
          timings: {JSON.stringify(run.timings)}
        </p>
      )}
      <table>
        <tbody>
          {events.map((e) => (
            <tr key={e.seq}>
              <td>{e.seq}</td>
              <td>{e.type}</td>
              <td>{e.exp_id ?? ""}</td>
              <td>{summary(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {run?.error_tail && <pre style={{ whiteSpace: "pre-wrap" }}>{run.error_tail}</pre>}
    </main>
  );
}
