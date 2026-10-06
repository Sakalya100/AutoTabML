"use client";

import { motion } from "motion/react";
import { fmtNum, formatScore } from "@/lib/metrics";
import { REEF } from "@/lib/scene/contract";
import type { LandingFacts } from "./facts";
import { EASE } from "./primitives";

const SIGNAL_LABEL: Record<string, string> = {
  noise_floor: "Noise floor",
  saturation: "Saturation fit",
  exploration: "Exploration exhausted",
  external_ref: "External reference",
};

/** Best-so-far vs the engine's own fitted saturation curve, and the four ceiling signals as lamps. */
export function CeilingViz({ stop, metric }: { stop: NonNullable<LandingFacts["stop"]>; metric: string }) {
  return (
    <div className="lp-panel">
      <SaturationChart stop={stop} metric={metric} />
      <ul className="mt-5 grid gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10">
        {stop.signals.map((s, i) => {
          const state = s.fired === true ? "fired" : s.fired === false ? "not fired" : "not configured";
          const on = s.fired === true;
          return (
            <motion.li
              key={s.key}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 bg-[color:var(--lp-panel-solid)] px-4 py-3"
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ duration: 0.6, delay: 0.3 + i * 0.22, ease: EASE }}
            >
              <motion.span
                aria-hidden
                className="mt-1 block size-3 rounded-full"
                style={{ background: on ? REEF.surfaceLight : "transparent", border: on ? "none" : "1px dashed rgba(190,210,255,0.4)" }}
                initial={on ? { boxShadow: "0 0 0px rgba(191,246,255,0)" } : undefined}
                whileInView={on ? { boxShadow: "0 0 18px rgba(191,246,255,0.9)" } : undefined}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: 0.6 + i * 0.22 }}
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-[14.5px] text-[color:var(--lp-ink)]">{SIGNAL_LABEL[s.key] ?? s.key}</span>
                  <span className={`font-mono text-[10.5px] uppercase tracking-[0.14em] ${on ? "text-[color:var(--lp-surface)]" : "text-[color:var(--lp-ink-3)]"}`}>{state}</span>
                </div>
                <p className="mt-0.5 text-[12.5px] leading-snug text-[color:var(--lp-ink-3)]">{s.detail}</p>
              </div>
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}

function SaturationChart({ stop, metric }: { stop: NonNullable<LandingFacts["stop"]>; metric: string }) {
  const ys = stop.trajectory;
  if (ys.length < 2) return null;
  const W = 520;
  const H = 190;
  const L = 8;
  const R = 92;
  const T = 16;
  const B = 22;
  const n = ys.length;
  const p = stop.saturationParams;
  const curve = p ? Array.from({ length: 121 }, (_, k) => (k / 120) * (n - 1)).map((t) => [t, p[0] - p[1] * Math.exp(-p[2] * t)] as const) : [];
  const vals = [...ys, ...curve.map((c) => c[1]), ...(p ? [p[0]] : [])];
  const se = stop.se ?? 0;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals) + se;
  const x = (t: number) => L + (t / (n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const step = ys.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(i === 0 ? v : ys[i - 1]).toFixed(1)} L${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const fit = curve.map(([t, v], i) => `${i === 0 ? "M" : "L"}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const last = ys[n - 1];
  const remaining = stop.signals.find((s) => s.key === "saturation")?.value;
  return (
    <figure>
      <figcaption className="lp-micro flex justify-between gap-3">
        <span>best-so-far {metric.replace(/_/g, "-")} · {n} experiments</span>
        {p && <span className="text-[color:var(--lp-surface)]">fit a − b·e^(−ct)</span>}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 block w-full" role="img" aria-label="Best-so-far score per experiment with the fitted saturation curve">
        {p && (
          <>
            <motion.rect
              x={L}
              width={W - L - R}
              y={y(p[0])}
              height={Math.max(1, y(p[0] - se) - y(p[0]))}
              fill="rgba(191,246,255,0.08)"
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 1.6, duration: 1 }}
            />
            <motion.line
              x1={L}
              x2={W - R}
              y1={y(p[0])}
              y2={y(p[0])}
              stroke={REEF.surfaceLight}
              strokeDasharray="4 4"
              initial={{ pathLength: 0, opacity: 0 }}
              whileInView={{ pathLength: 1, opacity: 0.9 }}
              viewport={{ once: true }}
              transition={{ delay: 1.4, duration: 1.2, ease: EASE }}
            />
            <text x={W - R + 8} y={y(p[0]) + 4} className="lp-svg-label" fill={REEF.surfaceLight}>
              ceiling {formatScore(metric, p[0], 4)}
            </text>
          </>
        )}
        <motion.path
          d={step}
          fill="none"
          stroke={REEF.best}
          strokeWidth={2}
          initial={{ pathLength: 0 }}
          whileInView={{ pathLength: 1 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 1.6, ease: EASE }}
        />
        {p && (
          <motion.path
            d={fit}
            fill="none"
            stroke={REEF.surfaceLight}
            strokeWidth={1.2}
            strokeOpacity={0.7}
            initial={{ pathLength: 0 }}
            whileInView={{ pathLength: 1 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 1.6, delay: 0.5, ease: EASE }}
          />
        )}
        <circle cx={x(n - 1)} cy={y(last)} r={3.5} fill={REEF.best} />
        <text x={W - R + 8} y={y(last) + (p && Math.abs(y(last) - y(p[0])) < 14 ? 16 : 4)} className="lp-svg-label" fill={REEF.best}>
          best {formatScore(metric, last, 4)}
        </text>
        <text x={L} y={H - 4} className="lp-svg-label">
          e000
        </text>
        <text x={W - R} y={H - 4} textAnchor="end" className="lp-svg-label">
          #{n}
        </text>
      </svg>
      {typeof remaining === "number" && stop.se != null && (
        <p className="mt-1 font-mono text-[11px] text-[color:var(--lp-ink-3)]">
          predicted remaining gain {fmtNum(remaining, 5)} {remaining < stop.se ? "<" : "≥"} one standard error {fmtNum(stop.se, 5)}
        </p>
      )}
    </figure>
  );
}
