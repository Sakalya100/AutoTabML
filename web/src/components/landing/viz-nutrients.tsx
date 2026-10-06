"use client";

import { motion } from "motion/react";
import { REEF } from "@/lib/scene/contract";
import type { LandingFacts } from "./facts";
import { EASE } from "./primitives";

const kindColor = (k: string) => (REEF.nutrient as Record<string, string>)[k] ?? REEF.nutrient.numeric;

/** The profile as nutrients: one glyph per real column (its own min/q25/median/q75/max), plus the rows that never cross. */
export function NutrientsViz({ profile }: { profile: NonNullable<LandingFacts["profile"]> }) {
  const rows = profile.nRows;
  const crossing = profile.sampleRows;
  return (
    <div className="lp-panel">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Stat k="rows" v={rows.toLocaleString("en-US")} />
        <Stat k="columns" v={String(profile.nCols)} />
        <Stat k="target" v={profile.target} sub={`${profile.problemType}${profile.classCounts.length ? " · " + profile.classCounts.map(([, n]) => n).join(" / ") : ""}`} />
        <Stat k="flagged" v={String(profile.flagged)} sub={profile.kinds.map(([k, n]) => `${n} ${k}`).join(" · ")} />
      </dl>

      <div className="mt-6">
        <div className="lp-micro flex justify-between">
          <span>each column, as the agent sees it</span>
          <span>min · q25 · median · q75 · max</span>
        </div>
        <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-[5px] sm:grid-cols-2">
          {profile.columns.map((c, i) => (
            <motion.li
              key={c.name}
              className="grid grid-cols-[minmax(0,9.5rem)_1fr] items-center gap-3"
              initial={{ opacity: 0, x: -18 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ duration: 0.7, delay: 0.15 + (i % 15) * 0.035 + Math.floor(i / 15) * 0.08, ease: EASE }}
            >
              <span className="truncate font-mono text-[10.5px] text-[color:var(--lp-ink-3)]" title={c.name}>
                {c.name}
              </span>
              <Box box={c.box} color={kindColor(c.kind)} />
            </motion.li>
          ))}
        </ul>
      </div>

      <div className="mt-7">
        <div className="lp-micro flex justify-between gap-4">
          <span>
            {rows.toLocaleString("en-US")} rows stay inside the harness
          </span>
          <span className="text-[color:var(--lp-gold)]">{crossing} sample rows cross into the prompt</span>
        </div>
        <Membrane rows={rows} crossing={crossing} />
      </div>
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="lp-micro">{k}</dt>
      <dd className="mt-1 truncate font-display text-[1.65rem] leading-none text-[color:var(--lp-ink)]">{v}</dd>
      {sub && <dd className="mt-1 truncate font-mono text-[10.5px] text-[color:var(--lp-ink-3)]">{sub}</dd>}
    </div>
  );
}

function Box({ box, color }: { box: [number, number, number, number, number] | null; color: string }) {
  if (!box) return <span className="h-px w-full bg-white/10" />;
  const [mn, q1, md, q3, mx] = box;
  const pct = (z: number) => `${(z * 100).toFixed(2)}%`;
  return (
    <span className="relative block h-[10px] w-full" aria-hidden>
      <span className="absolute top-1/2 h-px -translate-y-1/2 opacity-50" style={{ left: pct(mn), width: pct(mx - mn), background: color }} />
      <span
        className="absolute top-[1px] bottom-[1px] rounded-[2px]"
        style={{ left: pct(q1), width: pct(Math.max(0.006, q3 - q1)), background: `color-mix(in oklch, ${color} 38%, transparent)`, boxShadow: `0 0 10px ${color}55` }}
      />
      <span className="absolute top-0 bottom-0 w-[2px] rounded" style={{ left: pct(md), background: color }} />
    </span>
  );
}

/** Every row of the table as a hairline; the sample rows are the only ones lit. Positions are spread evenly — only the count is data. */
function Membrane({ rows, crossing }: { rows: number; crossing: number }) {
  const W = 600;
  const lit = new Set(Array.from({ length: crossing }, (_, i) => Math.round(((i + 0.5) / crossing) * rows)));
  return (
    <svg viewBox={`0 0 ${W} 34`} className="mt-3 block h-[34px] w-full" preserveAspectRatio="none" role="img" aria-label={`${rows} rows, ${crossing} shown to the agent`}>
      {Array.from({ length: rows }, (_, i) => {
        const x = (i / rows) * W;
        const on = lit.has(i);
        return on ? (
          <motion.rect
            key={i}
            x={x - 0.6}
            width={2.2}
            fill={REEF.best}
            initial={{ y: 30, height: 4, opacity: 0 }}
            whileInView={{ y: 0, height: 34, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1.1, delay: 0.6 + [...lit].indexOf(i) * 0.12, ease: EASE }}
          />
        ) : (
          <rect key={i} x={x} y={10} width={0.55} height={14} fill="rgba(170,200,255,0.16)" />
        );
      })}
      <line x1={0} x2={W} y1={17} y2={17} stroke="rgba(170,200,255,0.12)" strokeDasharray="2 3" />
    </svg>
  );
}
