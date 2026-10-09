"use client";

import { useId, type ReactNode } from "react";
import SpotlightCard from "@/components/bits/SpotlightCard";
import { fmtCompact, fmtGap, fmtPct, fmtSpan, fmtUsd, type Dashboard } from "@/lib/dashboard";
import { TweenNumber } from "./motion";

/** A tiny per-day bar strip under a number: no axes, the rhythm is the point. Drawn in by a clip wipe. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2 || values.every((v) => v === 0)) return <span className="dash-spark dash-spark-flat" aria-hidden />;
  const W = 240;
  const H = 34;
  const max = Math.max(...values) || 1;
  const step = W / values.length;
  const bw = Math.max(1, Math.min(step * 0.62, 7));
  return (
    <svg className="dash-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      {values.map((v, i) => {
        const h = v > 0 ? Math.max(3, (v / max) * (H - 4)) : 1;
        return (
          <rect
            key={i}
            x={i * step + (step - bw) / 2}
            y={H - h}
            width={bw}
            height={h}
            rx={Math.min(1.5, bw / 2)}
            className={v > 0 ? "dash-spark-bar" : "dash-spark-zero"}
          />
        );
      })}
    </svg>
  );
}

/** An (i) that explains a number on hover or focus. */
export function InfoTip({ children, label = "What is this?" }: { children: ReactNode; label?: string }) {
  const id = useId();
  return (
    <span className="dash-tip">
      <button type="button" className="dash-tip-btn" aria-label={label} aria-describedby={id}>
        i
      </button>
      <span role="tooltip" id={id} className="dash-tip-body">
        {children}
      </span>
    </span>
  );
}

interface TileProps {
  label: string;
  value: number | null;
  format: (n: number) => string;
  foot: ReactNode;
  spark?: number[];
  tip?: ReactNode;
  i: number;
  prefix?: string;
  sparkKey: string;
}

function Tile({ label, value, format, foot, spark, tip, i, prefix, sparkKey }: TileProps) {
  return (
    <SpotlightCard
      className="dash-tile"
      spotlightColor="rgb(255 226 180)"
      intensity={0.09}
      borderGlow={0.5}
      spotlightSize={220}
      proximity={60}
      style={
        {
          "--spotlight-card-surface": "var(--dash-card)",
          "--spotlight-card-border": "var(--dash-hair)",
          "--spotlight-card-shadow": "none",
          "--i": i,
        } as React.CSSProperties
      }
    >
      <div className="dash-tile-top">
        <span className="dash-label">{label}</span>
        {tip ? <InfoTip label={`About ${label.toLowerCase()}`}>{tip}</InfoTip> : null}
      </div>
      <p className="dash-tile-value">
        {prefix ? <span className="dash-tile-prefix">{prefix}</span> : null}
        {value == null ? <span>—</span> : <TweenNumber value={value} format={format} delay={0.25 + i * 0.07} />}
      </p>
      <div className="dash-tile-foot">{foot}</div>
      {spark ? (
        <div className="dash-tile-spark" key={sparkKey}>
          <Sparkline values={spark} />
        </div>
      ) : null}
    </SpotlightCard>
  );
}

export function KpiRow({ d, days }: { d: Dashboard; days: number }) {
  const s = d.summary;
  const col = (k: "runs" | "experiments" | "equivCostUsd") => d.series.map((x) => x[k]);
  const key = `${days}`;
  const int = (n: number) => fmtCompact(Math.round(n));
  return (
    <section className="dash-kpis" aria-label="Key numbers">
      <Tile
        i={0}
        sparkKey={key}
        label="Runs"
        value={s.runs}
        format={int}
        spark={col("runs")}
        foot={
          <>
            <b>{fmtPct(s.successRate)}</b> finished cleanly{s.running ? ` · ${s.running} running` : ""}
          </>
        }
      />
      <Tile
        i={1}
        sparkKey={key}
        label="Experiments"
        value={s.experiments}
        format={int}
        spark={col("experiments")}
        foot={
          <>
            <span className="dash-dot-kept" aria-hidden />
            <b>{fmtCompact(s.kept)}</b> kept · {fmtPct(s.keepRate)}
          </>
        }
      />
      <Tile
        i={2}
        sparkKey={key}
        label="Models ready"
        value={s.models}
        format={int}
        foot={
          <>
            trained pipelines from <b>{s.finished}</b> finished {s.finished === 1 ? "run" : "runs"}, ready to download
          </>
        }
      />
      <Tile
        i={3}
        sparkKey={key}
        label="Equivalent cost"
        prefix="≈"
        value={s.equivCostUsd}
        format={fmtUsd}
        spark={col("equivCostUsd")}
        tip={
          <>
            What these {fmtCompact(s.tokensIn + s.tokensOut)} tokens would cost on {d.pricing.provider} {d.pricing.model} (${d.pricing.input} in / $
            {d.pricing.output} out per million). Runs use free tiers, so the actual spend is <b>$0</b>.
          </>
        }
        foot={
          <>
            <b>$0</b> actually spent · {fmtCompact(s.tokensIn + s.tokensOut)} tokens
          </>
        }
      />
      <Tile
        i={4}
        sparkKey={key}
        label="Compute time"
        value={s.computeSeconds}
        format={fmtSpan}
        foot={
          <>
            <b>{fmtSpan(s.avgRunSeconds)}</b> per run on average
          </>
        }
      />
      <Tile
        i={5}
        sparkKey={key}
        label="Honesty"
        value={s.medianOptimismGap}
        format={fmtGap}
        tip={
          <>
            The median gap between a run’s own cross-validated estimate and its score on the locked test it never saw. Positive means the test fell short of the
            estimate. Lower is better; near zero means the estimates can be trusted.
          </>
        }
        foot={<>median test shortfall · lower is better</>}
      />
    </section>
  );
}
