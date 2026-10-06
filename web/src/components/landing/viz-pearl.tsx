"use client";

import { motion } from "motion/react";
import { fmtNum, formatScore, metricInfo } from "@/lib/metrics";
import { REEF } from "@/lib/scene/contract";
import type { LandingFacts } from "./facts";
import { EASE } from "./primitives";

/** The locked test, opened once: the pearl rises to its real height next to the dev-CV and select scores. */
export function PearlViz({ final, metric }: { final: NonNullable<LandingFacts["final"]>; metric: string }) {
  const W = 520;
  const H = 250;
  const T = 26;
  const B = 46;
  const vals = [final.devCv, final.select, final.test];
  const span = Math.max(...vals) - Math.min(...vals) || 1e-3;
  const lo = Math.min(...vals) - span * 0.35;
  const hi = Math.max(...vals) + span * 0.25;
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const label = metricInfo(metric).label;
  const marks = [
    { k: "dev CV mean", v: final.devCv, x: 90, color: REEF.best },
    { k: "select holdout", v: final.select, x: 250, color: REEF.halo },
  ];
  const tx = 410;
  const seabed = H - 22;
  return (
    <div className="lp-panel">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={`${label}: dev CV ${formatScore(metric, final.devCv)}, select ${formatScore(metric, final.select)}, test ${formatScore(metric, final.test)}`}>
        <defs>
          <radialGradient id="lp-pearl" cx="0.35" cy="0.35" r="0.75">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.45" stopColor={REEF.pearl} />
            <stop offset="1" stopColor="#a9a3d6" />
          </radialGradient>
          <filter id="lp-glow" x="-1" y="-1" width="3" height="3">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={20} x2={W - 20} y1={T + f * (H - T - B)} y2={T + f * (H - T - B)} stroke="rgba(190,210,255,0.06)" />
        ))}
        <line x1={20} x2={W - 20} y1={seabed} y2={seabed} stroke="rgba(190,210,255,0.18)" />
        {marks.map((m, i) => (
          <motion.g key={m.k} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} transition={{ delay: 0.2 + i * 0.25, duration: 0.7 }}>
            <line x1={m.x} x2={m.x} y1={seabed} y2={y(m.v)} stroke={m.color} strokeOpacity={0.35} />
            <line x1={m.x - 26} x2={m.x + 26} y1={y(m.v)} y2={y(m.v)} stroke={m.color} strokeWidth={2.5} />
            <text x={m.x} y={y(m.v) - 10} textAnchor="middle" className="lp-svg-num" fill={m.color}>
              {formatScore(metric, m.v, 4)}
            </text>
            <text x={m.x} y={H - 2} textAnchor="middle" className="lp-svg-label">
              {m.k}
            </text>
          </motion.g>
        ))}
        {/* the shell on the seabed: a bowl and a lid that opens once */}
        <path d={`M${tx - 20} ${seabed - 4} Q${tx} ${seabed + 10} ${tx + 20} ${seabed - 4} Z`} fill="rgba(244,241,255,0.14)" stroke="rgba(244,241,255,0.5)" />
        <motion.path
          d={`M${tx - 20} ${seabed - 4} Q${tx} ${seabed - 18} ${tx + 20} ${seabed - 4} Z`}
          fill="rgba(244,241,255,0.1)"
          stroke="rgba(244,241,255,0.5)"
          initial={{ x: 0, y: 0, opacity: 1 }}
          whileInView={{ x: -14, y: -10, opacity: 0.45 }}
          viewport={{ once: true }}
          transition={{ delay: 0.8, duration: 0.9, ease: EASE }}
        />
        <motion.line
          x1={tx}
          x2={tx}
          y1={seabed - 6}
          y2={y(final.test)}
          stroke={REEF.pearl}
          strokeOpacity={0.3}
          strokeDasharray="2 3"
          initial={{ pathLength: 0 }}
          whileInView={{ pathLength: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 1.1, duration: 1.4, ease: EASE }}
        />
        <motion.g initial={{ y: seabed - 8 - y(final.test), opacity: 0 }} whileInView={{ y: 0, opacity: 1 }} viewport={{ once: true }} transition={{ delay: 1.1, duration: 1.6, ease: EASE }}>
          <circle cx={tx} cy={y(final.test)} r={13} fill={REEF.pearl} opacity={0.5} filter="url(#lp-glow)" />
          <circle cx={tx} cy={y(final.test)} r={8} fill="url(#lp-pearl)" />
        </motion.g>
        <motion.g initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} transition={{ delay: 2.6, duration: 0.8 }}>
          <text x={tx} y={y(final.test) - 18} textAnchor="middle" className="lp-svg-num" fill={REEF.pearl}>
            {formatScore(metric, final.test, 4)}
          </text>
          {/* optimism gap bracket: select ↔ test */}
          <line x1={276} x2={tx - 16} y1={y(final.select)} y2={y(final.select)} stroke={REEF.halo} strokeOpacity={0.4} strokeDasharray="3 3" />
          <line x1={tx - 16} x2={tx - 16} y1={y(final.select)} y2={y(final.test)} stroke={REEF.pearl} strokeWidth={1.5} />
          <text x={tx - 22} y={(y(final.select) + y(final.test)) / 2 + 4} textAnchor="end" className="lp-svg-label" fill={REEF.pearl}>
            gap {final.gap > 0 ? "+" : "−"}
            {fmtNum(Math.abs(final.gap), 4)}
          </text>
        </motion.g>
        <text x={tx + 6} y={H - 2} textAnchor="middle" className="lp-svg-label">
          locked test · once
        </text>
      </svg>
      <p className="mt-3 text-[14px] leading-snug text-[color:var(--lp-ink-2)]">
        <span className="font-mono text-[12px] text-[color:var(--lp-pearl)]">{label} </span>
        {final.gapText}.
      </p>
    </div>
  );
}
