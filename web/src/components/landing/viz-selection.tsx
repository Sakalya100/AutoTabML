"use client";

import { motion } from "motion/react";
import { formatScore, fmtNum } from "@/lib/metrics";
import { REEF } from "@/lib/scene/contract";
import type { LandingFacts, PairFact } from "./facts";
import { EASE } from "./primitives";

/** Fold-by-fold: the same CV folds scored by parent and child. The gate tests the paired differences. */
export function SelectionViz({ facts }: { facts: LandingFacts }) {
  const pairs = [facts.keepPair, facts.discardPair].filter((p): p is PairFact => p != null);
  const all = pairs.flatMap((p) => [...p.exp.folds, ...p.parent.folds]);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const dmax = Math.max(...pairs.flatMap((p) => p.exp.folds.map((f, i) => Math.abs(f - p.parent.folds[i]))), 1e-9);
  return (
    <div className="lp-panel">
      <div className="grid gap-6 sm:grid-cols-2">
        {pairs.map((p) => (
          <Pair key={p.exp.id} p={p} lo={lo} hi={hi} dmax={dmax} metric={facts.metric} alpha={facts.gate.alpha} />
        ))}
      </div>
      <div className="mt-6 flex flex-wrap items-baseline gap-x-5 gap-y-1 border-t border-white/10 pt-4 font-mono text-[11.5px] text-[color:var(--lp-ink-3)]">
        <span>
          <span className="text-[color:var(--lp-ink)]">{facts.nExperiments}</span> experiments
        </span>
        <span>
          <span className="text-[color:var(--lp-keep)]">{facts.nKept}</span> kept <span className="opacity-70">(incl. baseline)</span>
        </span>
        <span>
          <span style={{ color: REEF.discard }}>{facts.nDiscarded}</span> withered
        </span>
        <span>
          <span style={{ color: REEF.crash }}>{facts.nCrashed}</span> crashed
        </span>
      </div>
    </div>
  );
}

function Pair({ p, lo, hi, dmax, metric, alpha }: { p: PairFact; lo: number; hi: number; dmax: number; metric: string; alpha: number | null }) {
  const kept = p.decision === "keep";
  const W = 260;
  const H = 176;
  const xa = 62;
  const xb = W - 62;
  const pad = 14;
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const up = kept ? REEF.keep : REEF.discard;
  const diffs = p.exp.folds.map((f, i) => f - p.parent.folds[i]);
  const meanD = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const dx = (d: number) => W / 2 + (d / dmax) * (W / 2 - 14);
  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px]" style={{ color: kept ? REEF.keep : REEF.discard }}>
          {kept ? "● kept" : "○ withered"}
        </span>
        <span className="truncate font-mono text-[10.5px] text-[color:var(--lp-ink-3)]">
          {p.parent.id} → {p.exp.id}
        </span>
      </figcaption>
      <p className="mt-1 line-clamp-2 min-h-[2.6em] text-[13px] leading-snug text-[color:var(--lp-ink-2)]">{p.exp.title}</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 block w-full" role="img" aria-label={`${p.exp.folds.length} paired CV folds, ${p.parent.id} versus ${p.exp.id}`}>
        <line x1={xa} x2={xa} y1={pad - 6} y2={H - pad + 6} stroke="rgba(190,210,255,0.14)" />
        <line x1={xb} x2={xb} y1={pad - 6} y2={H - pad + 6} stroke="rgba(190,210,255,0.14)" />
        {p.parent.folds.map((a, i) => {
          const b = p.exp.folds[i];
          const color = b > a ? up : b < a ? REEF.crash : "rgba(190,210,255,0.35)";
          return (
            <g key={i}>
              <motion.line
                x1={xa}
                y1={y(a)}
                x2={xb}
                y2={y(b)}
                stroke={color}
                strokeWidth={1.2}
                strokeOpacity={0.75}
                initial={{ pathLength: 0 }}
                whileInView={{ pathLength: 1 }}
                viewport={{ once: true, amount: 0.4 }}
                transition={{ duration: 0.9, delay: 0.3 + i * 0.07, ease: EASE }}
              />
              <motion.circle cx={xa} cy={y(a)} r={3} fill="#9fb2d6" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} transition={{ delay: 0.1 + i * 0.05 }} />
              <motion.circle cx={xb} cy={y(b)} r={3} fill={color} initial={{ opacity: 0, scale: 0 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true }} transition={{ delay: 0.9 + i * 0.07, duration: 0.4 }} />
            </g>
          );
        })}
        <MeanMark x={xa - 10} y={y(p.parent.mean)} side="left" />
        <MeanMark x={xb + 10} y={y(p.exp.mean)} side="right" color={kept ? REEF.keep : REEF.discard} />
        <text x={xa} y={H - 1} textAnchor="middle" className="lp-svg-label">
          {p.parent.id}
        </text>
        <text x={xb} y={H - 1} textAnchor="middle" className="lp-svg-label">
          {p.exp.id}
        </text>
        <text x={xa - 14} y={y(p.parent.mean) + 3.5} textAnchor="end" className="lp-svg-label">
          {formatScore(metric, p.parent.mean, 4)}
        </text>
        <text x={xb + 14} y={y(p.exp.mean) + 3.5} textAnchor="start" className="lp-svg-label">
          {formatScore(metric, p.exp.mean, 4)}
        </text>
      </svg>

      <div className="lp-micro mt-3">per-fold difference</div>
      <svg viewBox={`0 0 ${W} 30`} className="mt-1 block w-full" aria-hidden>
        <line x1={W / 2} x2={W / 2} y1={2} y2={28} stroke="rgba(190,210,255,0.35)" strokeDasharray="2 2" />
        <line x1={8} x2={W - 8} y1={15} y2={15} stroke="rgba(190,210,255,0.12)" />
        {diffs.map((d, i) => (
          <motion.circle
            key={i}
            cy={15 + ((i % 3) - 1) * 5}
            r={2.6}
            fill={d > 0 ? up : d < 0 ? REEF.crash : "#8796b5"}
            initial={{ cx: W / 2, opacity: 0 }}
            whileInView={{ cx: dx(d), opacity: 0.95 }}
            viewport={{ once: true }}
            transition={{ duration: 0.9, delay: 1.4 + i * 0.05, ease: EASE }}
          />
        ))}
        <motion.rect
          y={4}
          width={2}
          height={22}
          fill={kept ? REEF.keep : REEF.discard}
          initial={{ x: W / 2 - 1, opacity: 0 }}
          whileInView={{ x: dx(meanD) - 1, opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 1, delay: 2, ease: EASE }}
        />
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-3 font-mono text-[11px] tabular">
        <span className="text-[color:var(--lp-ink-2)]">
          gain {p.gainSe != null ? `${p.gainSe > 0 ? "+" : ""}${p.gainSe.toFixed(2)} SE` : "—"}
        </span>
        <span style={{ color: kept ? REEF.keep : REEF.discard }}>
          p = {p.p != null ? fmtNum(p.p, 3) : "—"} {alpha != null && p.p != null ? (p.p < alpha ? `< ${alpha}` : `≥ ${alpha}`) : ""}
        </span>
      </div>
    </figure>
  );
}

function MeanMark({ x, y, side, color = "#9fb2d6" }: { x: number; y: number; side: "left" | "right"; color?: string }) {
  const d = side === "left" ? `M${x} ${y} l6 -4 v8 z` : `M${x} ${y} l-6 -4 v8 z`;
  return <path d={d} fill={color} />;
}
