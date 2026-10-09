"use client";

/*
 * The latest runs, newest first. Each row is one link to its session. A table on wide screens (column heads shown
 * once; every cell also carries a visually-hidden label, so a row reads whole to a screen reader), a stack of cards
 * on phones. Rows rise in, in a stagger, as they scroll into view; a soft light follows the pointer over a row.
 */
import Link from "next/link";
import { useRef } from "react";
import { fmtCompact, fmtGap, fmtScore, fmtSpan, fmtUsd, relTime, type DashRun } from "@/lib/dashboard";
import { metricInfo } from "@/lib/metrics";
import { EASE, gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/motion/gsap";
import { runEndView } from "@/lib/run-failure";
import { useSpotlight } from "./motion";

const STATUS: Record<string, { label: string; tone: "ok" | "run" | "bad" | "muted" }> = {
  finished: { label: "Finished", tone: "ok" },
  running: { label: "Running", tone: "run" },
  queued: { label: "Queued", tone: "run" },
  pending: { label: "Starting", tone: "run" },
  failed: { label: "Failed", tone: "bad" },
  timed_out: { label: "Timed out", tone: "bad" },
  cancelled: { label: "Stopped", tone: "muted" },
};
const statusOf = (s: string) => STATUS[s] ?? { label: s.replace(/_/g, " "), tone: "muted" as const };

/** What went wrong, in plain words (the same titles the run page uses). */
function failureWords(r: DashRun): string | null {
  if (r.status !== "failed" && r.status !== "timed_out") return null;
  if (!r.errorCode) return r.status === "timed_out" ? "It ran out of time" : "Something went wrong";
  return runEndView({ status: "failed", error: null, errorCode: r.errorCode }).title;
}

const dataName = (r: DashRun) => (r.dataset ?? r.sessionTitle ?? "Untitled data").replace(/\.(csv|tsv|parquet|xlsx?)$/i, "");

function Row({ r }: { r: DashRun }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useSpotlight(ref);
  const st = statusOf(r.status);
  const fail = failureWords(r);
  const m = r.metric ? metricInfo(r.metric).label : null;
  return (
    <li className="dash-run-li">
      <Link ref={ref} href={`/s/${encodeURIComponent(r.sessionId)}`} className="dash-run" data-tone={st.tone}>
        <span className="dash-run-main">
          <span className="dash-run-name">{dataName(r)}</span>
          <span className="dash-run-meta">
            {fail ? (
              <span className="dash-run-fail">{fail}</span>
            ) : (
              <>
                <span className="sr-only">Predicting </span>
                {r.target ? <span className="dash-run-target">{r.target}</span> : null}
                {m ? <span> · {m}</span> : null}
              </>
            )}
            <span className="dash-run-when"> · {relTime(r.createdAt)}</span>
          </span>
        </span>
        <span className="dash-run-cell dash-run-status">
          <span className="dash-pill" data-tone={st.tone}>
            <span className="dash-pill-dot" aria-hidden />
            {st.label}
          </span>
        </span>
        <span className="dash-run-cell dash-run-exp">
          <span className="dash-cell-k">Kept</span>
          <span className="dash-mono">
            <b data-kept={r.kept > 0 ? "" : undefined}>{r.kept}</b>
            <span className="dash-dim"> / {r.experiments}</span>
          </span>
        </span>
        <span className="dash-run-cell dash-run-score">
          <span className="dash-cell-k">CV → test</span>
          {r.bestCv == null && r.testScore == null ? (
            <span className="dash-dim">—</span>
          ) : (
            <span className="dash-mono">
              {fmtScore(r.bestCv)}
              <span className="dash-dim"> → </span>
              {fmtScore(r.testScore)}
            </span>
          )}
        </span>
        <span className="dash-run-cell dash-run-gap">
          <span className="dash-cell-k">Shortfall</span>
          <span className="dash-mono" data-bad={r.optimismGap != null && r.optimismGap > 0 ? "" : undefined}>
            {fmtGap(r.optimismGap)}
          </span>
        </span>
        <span className="dash-run-cell dash-run-dur">
          <span className="dash-cell-k">Time</span>
          <span className="dash-mono">{fmtSpan(r.durationS)}</span>
        </span>
        <span className="dash-run-cell dash-run-cost">
          <span className="dash-cell-k">≈ Cost</span>
          <span className="dash-mono" title={`${fmtCompact(r.tokens)} tokens`}>
            {r.equivCostUsd > 0 ? fmtUsd(r.equivCostUsd) : "—"}
          </span>
        </span>
        <span className="dash-run-cell dash-run-model">
          <span className="dash-cell-k">Model</span>
          {r.hasModel ? (
            <span className="dash-model-yes" title="A trained model is ready to download">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path d="M3 7.4l2.6 2.6L11 4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="sr-only">ready</span>
            </span>
          ) : (
            <span className="dash-dim">
              —<span className="sr-only">none</span>
            </span>
          )}
        </span>
        <span className="dash-run-go" aria-hidden>
          →
        </span>
      </Link>
    </li>
  );
}

export function RecentRuns({ runs }: { runs: DashRun[] }) {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const rows = gsap.utils.toArray<HTMLElement>(".dash-run-li");
      gsap.set(rows, { autoAlpha: 0, y: 22 });
      ScrollTrigger.batch(rows, {
        start: "top 92%",
        once: true,
        onEnter: (els) => gsap.to(els, { autoAlpha: 1, y: 0, duration: 0.9, ease: EASE.out, stagger: 0.06, overwrite: true }),
      });
    },
    { scope: root, dependencies: [runs.map((r) => r.id).join()] },
  );
  return (
    <section ref={root} className="dash-card dash-runs" aria-labelledby="dash-runs-h">
      <div className="dash-card-head">
        <div>
          <h2 id="dash-runs-h" className="dash-h2">
            Recent runs
          </h2>
          <p className="dash-card-sub">The latest {runs.length}, newest first. Open one to see its whole story.</p>
        </div>
        <Link href="/s/new" className="dash-textlink">
          Start another <span aria-hidden>→</span>
        </Link>
      </div>
      {runs.length === 0 ? (
        <p className="dash-none">No runs in this window. Pick a longer range, or start one.</p>
      ) : (
        <>
          <div className="dash-runs-head" aria-hidden>
            <span>Data</span>
            <span>Status</span>
            <span>Kept</span>
            <span>CV → test</span>
            <span>Shortfall</span>
            <span>Time</span>
            <span>≈ Cost</span>
            <span>Model</span>
            <span />
          </div>
          <ol className="dash-runs-list">
            {runs.map((r) => (
              <Row key={r.id} r={r} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
