"use client";

/*
 * The account dashboard: what you've run, what it found, what it would have cost and how far its estimates held up.
 * Night cartography, like the landing: void ground, bone type, amber only for the one thing to follow.
 * Data: GET /api/dashboard?days=N (backend). In development `?fixture=demo|empty|loading|error` previews each state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSignedIn } from "@/components/auth";
import { isEmptyDashboard, parseDashboard, subline, type Dashboard, type RangeDays } from "@/lib/dashboard";
import { demoDashboard, emptyDashboard } from "@/lib/dashboard-fixture";
import { ScrollTrigger } from "@/lib/motion/gsap";
import { ActivityChart } from "./activity";
import { DashHeader } from "./header";
import { HonestyScatter } from "./honesty";
import { KpiRow } from "./kpis";
import { RecentRuns } from "./recent-runs";
import { MetricsCard, PricingNote, ProvidersCard, TokensCard } from "./side";
import { DashEmpty, DashError, DashSignedOut, DashSkeleton } from "./states";
import "./dashboard.css";

type Fixture = "demo" | "empty" | "loading" | "error" | null;
type Load = { state: "loading" } | { state: "ready"; data: Dashboard; sample: boolean } | { state: "error"; message: string } | { state: "signed-out" };

const DEV = process.env.NODE_ENV !== "production";

function readFixture(): Fixture {
  if (!DEV || typeof window === "undefined") return null;
  const f = new URLSearchParams(window.location.search).get("fixture");
  return f === "demo" || f === "empty" || f === "loading" || f === "error" ? f : null;
}

export function DashboardPage() {
  const auth = useSignedIn();
  const [days, setDays] = useState<RangeDays>(30);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [nonce, setNonce] = useState(0);
  /** Which request the shown data answers; while it differs from the current one, a refetch is in flight. */
  const [answered, setAnswered] = useState("");
  const want = `${days}:${nonce}`;
  const refreshing = answered !== want;
  const fixture = useRef<Fixture>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    fixture.current = readFixture();
  }, []);

  useEffect(() => {
    if (!auth.loaded || !auth.signedIn) return;
    const f = fixture.current ?? readFixture();
    const ctl = new AbortController();
    const done = (l: Load) => {
      if (ctl.signal.aborted) return;
      setLoad(l);
      setAnswered(`${days}:${nonce}`);
      setNow(Date.now());
    };
    if (f === "loading") return () => ctl.abort();
    if (f === "error" || f === "demo" || f === "empty") {
      const t = setTimeout(
        () =>
          done(
            f === "error"
              ? { state: "error", message: "The server answered 503. Your runs are safe; this is only the summary." }
              : { state: "ready", data: f === "demo" ? demoDashboard(days) : emptyDashboard(days), sample: true },
          ),
        350,
      );
      return () => {
        clearTimeout(t);
        ctl.abort();
      };
    }
    (async () => {
      try {
        const res = await fetch(`/api/dashboard?days=${days}`, { cache: "no-store", signal: ctl.signal });
        if (res.status === 401 || res.status === 403) return done({ state: "signed-out" });
        if (res.status === 404 && DEV) return done({ state: "ready", data: demoDashboard(days), sample: true });
        if (!res.ok) return done({ state: "error", message: `The server answered ${res.status}. Your runs are safe; this is only the summary.` });
        done({ state: "ready", data: parseDashboard(await res.json()), sample: false });
      } catch (e) {
        if (ctl.signal.aborted) return;
        done({
          state: "error",
          message: e instanceof Error && e.message ? `${e.message}. Check your connection and try again.` : "Check your connection and try again.",
        });
      }
    })();
    return () => ctl.abort();
  }, [auth.loaded, auth.signedIn, auth.userId, days, nonce]);

  // Content replaced the skeleton (or a new range changed heights): re-measure every scroll trigger.
  const ready = load.state === "ready" ? load.data : null;
  useEffect(() => {
    const id = requestAnimationFrame(() => ScrollTrigger.refresh());
    return () => cancelAnimationFrame(id);
  }, [ready]);

  const retry = useCallback(() => {
    setLoad({ state: "loading" });
    setNonce((n) => n + 1);
  }, []);

  if (auth.loaded && (!auth.signedIn || load.state === "signed-out")) {
    return (
      <div className="dash-root" data-dashboard="">
        <div className="dash-wrap">
          <DashSignedOut />
        </div>
      </div>
    );
  }

  const data = ready;
  const empty = data ? isEmptyDashboard(data) : false;
  return (
    <div className="dash-root" data-dashboard="">
      <div className="dash-aura" aria-hidden />
      <div className="dash-wrap">
        <DashHeader
          line={
            load.state === "error" ? "Summary unavailable" : data ? (empty ? "No runs yet · your first takes a few minutes" : subline(data.summary, now)) : null
          }
          days={days}
          onDays={setDays}
        />
        {load.state === "ready" && load.sample ? (
          <p className="dash-sample">
            <span aria-hidden>◇</span> Sample data: a preview of the layout, not your runs.
          </p>
        ) : null}
        {load.state === "error" ? (
          <DashError onRetry={retry} message={load.message} />
        ) : !data ? (
          <DashSkeleton />
        ) : empty ? (
          <DashEmpty />
        ) : (
          <div className="dash-body" data-stale={refreshing ? "" : undefined} aria-busy={refreshing}>
            <KpiRow d={data} days={days} />
            <div className="dash-grid">
              <ActivityChart series={data.series} />
              <ProvidersCard providers={data.providers} />
            </div>
            <div className="dash-grid dash-grid-b">
              <HonestyScatter quality={data.quality} metricOrder={data.metrics.map((m) => m.metric)} />
              <div className="dash-stack">
                <MetricsCard metrics={data.metrics} />
                <TokensCard tokensIn={data.summary.tokensIn} tokensOut={data.summary.tokensOut} pricing={data.pricing} />
                <PricingNote pricing={data.pricing} />
              </div>
            </div>
            <RecentRuns runs={data.recentRuns} />
          </div>
        )}
      </div>
    </div>
  );
}
