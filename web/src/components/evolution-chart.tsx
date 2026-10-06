"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { linear, niceTicks, padDomain } from "@/lib/chart";
import { CATEGORY_LABEL } from "@/lib/format";
import { directionLabel, fmtNum, formatScore, metricInfo, toRaw } from "@/lib/metrics";
import { bestTrajectory, type ExpView, type RunView } from "@/lib/run-state";

interface Props {
  view: RunView;
  /** View of the complete run (replays) — fixes the axes so they don't jump while animating. */
  domainView?: RunView | null;
  /** Planned number of experiments, for a stable x axis during live runs. */
  plannedExperiments?: number | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  compact?: boolean;
}

const M = { top: 18, right: 108, bottom: 34, left: 58 };

function useWidth<T extends HTMLElement>(initial = 820) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function domainOf(v: RunView): [number, number] | null {
  const ys: number[] = [];
  for (const x of v.experiments) if (x.cv) ys.push(x.cv.mean + x.cv.se, x.cv.mean - x.cv.se);
  if (v.final) ys.push(v.final.selectScore, v.final.testScore);
  if (!ys.length) return null;
  return [Math.min(...ys), Math.max(...ys)];
}

export function EvolutionChart({ view, domainView, plannedExperiments, selectedId, onSelect, compact }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<ExpView | null>(null);
  const metric = view.metric ?? domainView?.metric ?? null;
  const info = metricInfo(metric);
  const narrow = width < 560;
  const m = narrow ? { ...M, right: 72, left: 48 } : M;
  const height = compact ? 230 : narrow ? 280 : 360;
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;

  const nMax = Math.max(
    domainView?.experiments.length ?? 0,
    view.experiments.length,
    plannedExperiments ?? 0,
    4,
  );
  const x = linear(-0.5, nMax - 0.5, m.left, m.left + plotW);

  const [lo, hi] = useMemo(() => {
    const d = domainOf(domainView ?? view) ?? domainOf(view);
    if (!d) return [-1, 0] as [number, number];
    return padDomain(d[0], d[1], 0.1);
  }, [domainView, view]);
  // Oriented scores: up is always "better", for minimised metrics too.
  const y = linear(lo, hi, m.top + plotH, m.top);
  const ticks = niceTicks(lo, hi, compact ? 4 : 6);
  const tickDigits = ticks.length > 1 ? Math.max(2, Math.min(5, Math.ceil(-Math.log10(Math.abs(ticks[1] - ticks[0]))) + 1)) : 3;

  const traj = bestTrajectory(view);
  const lastX = view.experiments.length ? view.experiments.length - 0.5 : 0;

  // Best-so-far step line and its ±1 SE band.
  let line = "";
  let bandTop = "";
  let bandBot = "";
  traj.forEach((p, i) => {
    // The line steps up exactly at the experiment whose decision changed the best.
    const x0 = x(p.index);
    const x1 = x(i + 1 < traj.length ? traj[i + 1].index : Math.min(lastX - 0.1, nMax - 0.5));
    const yy = y(p.mean);
    line += `${i === 0 ? "M" : "L"}${x0},${yy}L${x1},${yy}`;
    bandTop += `${i === 0 ? "M" : "L"}${x0},${y(p.mean + p.se)}L${x1},${y(p.mean + p.se)}`;
    bandBot = `L${x1},${y(p.mean - p.se)}L${x0},${y(p.mean - p.se)}` + bandBot;
  });
  const band = traj.length ? `${bandTop}${bandBot}Z` : "";
  const railY = m.top + plotH - 6;
  const best = traj.at(-1);
  const colX = m.left + plotW + (narrow ? 30 : 44);
  const fin = view.final;

  const label = `${info.label} by experiment. ${view.experiments.length} experiments; ${
    best ? `best ${formatScore(metric, best.mean)} (${best.id})` : "no scores yet"
  }${fin ? `; locked test ${formatScore(metric, fin.testScore)}` : ""}.`;

  return (
    <figure className="relative">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-ink-3">
        <span>
          <span className="font-medium text-ink-2">{info.label}</span> · {directionLabel(metric)}
          {!info.greaterIsBetter && <span className="hidden sm:inline"> · axis flipped so up is always better</span>}
        </span>
        <Legend />
      </div>
      <div ref={wrapRef} className="graph-paper relative rounded-md border border-rule bg-paper">
        <svg width={width} height={height} role="img" aria-label={label} className="block max-w-full select-none">
          {/* y grid + labels */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={m.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeDasharray="2 4" />
              <text x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-3 font-mono text-[10px] tabular">
                {fmtNum(toRaw(metric, t), tickDigits)}
              </text>
            </g>
          ))}
          {/* x labels */}
          {Array.from({ length: nMax }, (_, i) => i)
            .filter((i) => nMax <= 16 || i % Math.ceil(nMax / (narrow ? 6 : 12)) === 0)
            .map((i) => (
              <text key={i} x={x(i)} y={height - m.bottom + 16} textAnchor="middle" className="fill-ink-3 font-mono text-[10px] tabular">
                {i}
              </text>
            ))}
          <text x={m.left + plotW / 2} y={height - 4} textAnchor="middle" className="fill-ink-3 text-[10px] tracking-wider uppercase">
            experiment
          </text>
          {/* crash rail */}
          <line x1={m.left} x2={m.left + plotW} y1={railY} y2={railY} stroke="var(--rule)" />

          {/* locked-test column */}
          <line x1={m.left + plotW + 10} x2={m.left + plotW + 10} y1={m.top} y2={m.top + plotH} stroke="var(--rule-strong)" />
          {!fin && (
            <text
              x={colX}
              y={m.top + plotH / 2}
              textAnchor="middle"
              transform={`rotate(-90 ${colX} ${m.top + plotH / 2})`}
              className="fill-ink-3 text-[10px] tracking-[0.14em] uppercase"
            >
              locked test · scored once
            </text>
          )}

          {band && <path d={band} fill="var(--best-soft)" />}
          {line && <path d={line} fill="none" stroke="var(--best)" strokeWidth={2.5} strokeLinejoin="round" />}

          {/* per-experiment whiskers + dots */}
          {view.experiments.map((e) => {
            const cx = x(e.index);
            const sel = e.id === selectedId;
            const common = {
              role: "button" as const,
              tabIndex: 0,
              "aria-label": `${e.id}: ${e.idea.title} — ${e.status}${e.cv ? `, ${formatScore(metric, e.cv.mean)}` : ""}`,
              onMouseEnter: () => setHover(e),
              onMouseLeave: () => setHover((h) => (h?.id === e.id ? null : h)),
              onFocus: () => setHover(e),
              onBlur: () => setHover(null),
              onClick: () => onSelect?.(e.id),
              onKeyDown: (ev: React.KeyboardEvent) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect?.(e.id);
                }
              },
              className: "cursor-pointer outline-none",
            };
            if (e.status === "running") {
              const cy = best ? y(best.mean) : m.top + plotH / 2;
              return (
                <g key={e.id} {...common}>
                  <circle cx={cx} cy={cy} r={7} fill="none" stroke="var(--best)" strokeWidth={1.5} className="pulse-ring" />
                  <circle cx={cx} cy={cy} r={3} fill="var(--best)" />
                </g>
              );
            }
            if (e.status === "crash" || !e.cv) {
              return (
                <g key={e.id} {...common}>
                  <rect x={cx - 9} y={railY - 9} width={18} height={18} fill="transparent" />
                  <path d={`M${cx - 4},${railY - 4}L${cx + 4},${railY + 4}M${cx + 4},${railY - 4}L${cx - 4},${railY + 4}`} stroke="var(--crash)" strokeWidth={2} />
                  {sel && <circle cx={cx} cy={railY} r={9} fill="none" stroke="var(--ink)" strokeWidth={1.25} />}
                </g>
              );
            }
            const cy = y(e.cv.mean);
            const keep = e.status === "keep";
            return (
              <g key={e.id} {...common}>
                <line x1={cx} x2={cx} y1={y(e.cv.mean + e.cv.se)} y2={y(e.cv.mean - e.cv.se)} stroke={keep ? "var(--keep)" : "var(--discard)"} strokeOpacity={0.45} />
                <circle cx={cx} cy={cy} r={12} fill="transparent" />
                <circle
                  cx={cx}
                  cy={cy}
                  r={keep ? 5 : 4.25}
                  fill={keep ? "var(--keep)" : "var(--paper)"}
                  stroke={keep ? "var(--paper)" : "var(--discard)"}
                  strokeWidth={keep ? 1.5 : 1.75}
                  className="transition-[r] duration-300"
                />
                {sel && <circle cx={cx} cy={cy} r={9.5} fill="none" stroke="var(--ink)" strokeWidth={1.25} />}
              </g>
            );
          })}

          {/* final: select vs locked test, and the optimism gap */}
          {fin && (
            <g className="rise">
              <line x1={x(lastX)} x2={colX - 8} y1={y(fin.devCvMean)} y2={y(fin.devCvMean)} stroke="var(--best)" strokeDasharray="3 3" strokeOpacity={0.6} />
              <path
                d={`M${colX - 11},${y(fin.selectScore)} L${colX - 15},${y(fin.selectScore) - 4} M${colX - 11},${y(fin.selectScore)} L${colX - 15},${y(fin.selectScore) + 4}`}
                stroke="var(--rule-strong)"
                fill="none"
              />
              <line x1={colX} x2={colX} y1={y(fin.selectScore)} y2={y(fin.testScore)} stroke="var(--ink-3)" strokeWidth={1} />
              <rect x={colX - 4.5} y={y(fin.selectScore) - 4.5} width={9} height={9} transform={`rotate(45 ${colX} ${y(fin.selectScore)})`} fill="var(--select)" />
              <rect x={colX - 4.5} y={y(fin.testScore) - 4.5} width={9} height={9} fill="var(--test)" />
              {!narrow && (
                <>
                  <text x={colX + 10} y={y(fin.selectScore)} dy="0.32em" className="fill-select text-[10px] font-medium">
                    select
                  </text>
                  <text x={colX + 10} y={y(fin.testScore)} dy="0.32em" className="fill-ink text-[10px] font-medium">
                    test
                  </text>
                </>
              )}
            </g>
          )}
        </svg>
        {hover && <Tip e={hover} x={x(hover.index)} y={hover.cv ? y(hover.cv.mean) : railY} width={width} metric={metric} />}
      </div>
    </figure>
  );
}

function Tip({ e, x, y, width, metric }: { e: ExpView; x: number; y: number; width: number; metric: string | null }) {
  const left = Math.min(Math.max(8, x - 130), width - 268);
  const above = y > 120;
  return (
    <div
      className="pointer-events-none absolute z-10 w-[260px] rounded-md border border-rule-strong bg-paper px-3 py-2 text-xs shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)]"
      style={{ left, top: above ? y - 12 : y + 14, transform: above ? "translateY(-100%)" : undefined }}
    >
      <div className="flex items-center justify-between gap-2 text-ink-3">
        <span className="font-mono">{e.id}</span>
        <span>{CATEGORY_LABEL[e.idea.category] ?? e.idea.category}</span>
      </div>
      <div className="mt-0.5 font-medium leading-snug text-ink">{e.idea.title}</div>
      <div className="mt-1 font-mono tabular text-ink-2">
        {e.status === "running" ? "running…" : e.cv ? `${formatScore(metric, e.cv.mean)} ± ${fmtNum(e.cv.se)} · ${e.status}` : e.status}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="inline-flex items-center gap-1.5">
        <svg width="18" height="8" aria-hidden>
          <rect x="0" y="0" width="18" height="8" fill="var(--best-soft)" />
          <line x1="0" x2="18" y1="4" y2="4" stroke="var(--best)" strokeWidth="2.5" />
        </svg>
        best so far ±1 SE
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="10" height="10" aria-hidden>
          <circle cx="5" cy="5" r="4" fill="var(--keep)" />
        </svg>
        keep
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="10" height="10" aria-hidden>
          <circle cx="5" cy="5" r="3.5" fill="var(--paper)" stroke="var(--discard)" strokeWidth="1.6" />
        </svg>
        discard
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="10" height="10" aria-hidden>
          <path d="M1.5,1.5L8.5,8.5M8.5,1.5L1.5,8.5" stroke="var(--crash)" strokeWidth="2" />
        </svg>
        crash
      </span>
    </span>
  );
}
