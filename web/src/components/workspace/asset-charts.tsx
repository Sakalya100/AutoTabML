"use client";

/**
 * Small SVG charts for the run's assets (ROC / PR curves, confusion matrix, predicted-vs-actual, residuals, CV per
 * experiment), in the night style: hairline axes, amber for the first series and what was kept, bone for the rest.
 * Each chart has a full render (axes, ticks, legend, hover readout) and a `mini` thumbnail for the tiles.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AssetChart, CurveChart, CvPoint, HistogramChart, MatrixChart, Point, ScatterChart } from "@/lib/assets";
import { linear, niceTicks, padDomain } from "@/lib/chart";
import { fmtNum, formatScore, metricInfo, toRaw } from "@/lib/metrics";
import type { Metric } from "@/lib/schema";

const SERIES = ["var(--lp-signal)", "var(--lp-ink-2)", "var(--lp-ink-3)"];
/** Stagger index for the draw-in (workspace.css animates `.as-draw` children; static everywhere else). */
const at = (i: number) => ({ "--i": i }) as CSSProperties;
const M = { top: 14, right: 16, bottom: 44, left: 62 };
const MINI = { w: 120, h: 56 };
/** Plot margins (narrower left gutter on small widths); the hover maths uses the same numbers as the frame. */
const marg = (width: number) => (width < 420 ? { ...M, left: 54 } : M);

function useWidth<T extends HTMLElement>(initial = 560) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const fmt = (v: number, step: number) => {
  const d = step > 0 ? Math.max(0, Math.min(4, Math.ceil(-Math.log10(step)))) : 2;
  return v.toFixed(d);
};
const extent = (xs: number[]): [number, number] => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
};

interface Hover {
  x: number;
  y: number;
  lines: ReactNode[];
}

/** The frame every xy chart shares: grid, ticks, axis labels, and the hover readout. */
function Frame({
  width,
  height,
  xDomain,
  yDomain,
  xLabel,
  yLabel,
  label,
  hover,
  onMove,
  onLeave,
  xTickFmt,
  yTickFmt,
  children,
}: {
  width: number;
  height: number;
  xDomain: [number, number];
  yDomain: [number, number];
  xLabel: string;
  yLabel: string;
  label: string;
  hover: Hover | null;
  onMove?: (px: number, py: number) => void;
  onLeave?: () => void;
  xTickFmt?: (v: number) => string;
  yTickFmt?: (v: number) => string;
  children: (x: (v: number) => number, y: (v: number) => number) => ReactNode;
}) {
  const narrow = width < 420;
  const m = marg(width);
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const x = linear(xDomain[0], xDomain[1], m.left, m.left + plotW);
  const y = linear(yDomain[0], yDomain[1], m.top + plotH, m.top);
  const xt = niceTicks(xDomain[0], xDomain[1], narrow ? 4 : 6);
  const yt = niceTicks(yDomain[0], yDomain[1], 5);
  const xs = xt.length > 1 ? xt[1] - xt[0] : 1;
  const ys = yt.length > 1 ? yt[1] - yt[0] : 1;
  return (
    <div className="relative">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        className="block max-w-full touch-none select-none"
        onPointerMove={(e) => {
          if (!onMove) return;
          const r = e.currentTarget.getBoundingClientRect();
          onMove(e.clientX - r.left, e.clientY - r.top);
        }}
        onPointerLeave={onLeave}
      >
        {yt.map((t) => (
          <g key={`y${t}`}>
            <line x1={m.left} x2={m.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--lp-hair)" />
            <text x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="as-tick">
              {yTickFmt ? yTickFmt(t) : fmt(t, ys)}
            </text>
          </g>
        ))}
        {xt.map((t) => (
          <g key={`x${t}`}>
            <line x1={x(t)} x2={x(t)} y1={m.top + plotH} y2={m.top + plotH + 4} stroke="var(--lp-ink-3)" />
            <text x={x(t)} y={m.top + plotH + 16} textAnchor="middle" className="as-tick">
              {xTickFmt ? xTickFmt(t) : fmt(t, xs)}
            </text>
          </g>
        ))}
        <line x1={m.left} x2={m.left + plotW} y1={m.top + plotH} y2={m.top + plotH} stroke="var(--lp-ink-3)" strokeOpacity={0.6} />
        <line x1={m.left} x2={m.left} y1={m.top} y2={m.top + plotH} stroke="var(--lp-ink-3)" strokeOpacity={0.6} />
        {xLabel && (
          <text x={m.left + plotW / 2} y={height - 6} textAnchor="middle" className="as-axis">
            {xLabel}
          </text>
        )}
        {yLabel && (
          <text transform={`translate(12 ${m.top + plotH / 2}) rotate(-90)`} textAnchor="middle" className="as-axis">
            {yLabel}
          </text>
        )}
        <g>{children(x, y)}</g>
        {hover && <circle cx={hover.x} cy={hover.y} r={4.5} fill="none" stroke="var(--lp-ink)" strokeWidth={1.25} pointerEvents="none" />}
      </svg>
      {hover && <Tip x={hover.x} y={hover.y} width={width} lines={hover.lines} />}
    </div>
  );
}

function Tip({ x, y, width, lines }: { x: number; y: number; width: number; lines: ReactNode[] }) {
  const left = x > width - 150;
  return (
    <div className="as-tip" style={{ left: left ? undefined : x + 12, right: left ? width - x + 12 : undefined, top: Math.max(0, y - 18) }} aria-hidden>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

const path = (pts: Point[], x: (v: number) => number, y: (v: number) => number) =>
  pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");

function nearest(pts: { px: number; py: number }[], mx: number, my: number, max = 40) {
  let best = -1;
  let bd = max * max;
  pts.forEach((p, i) => {
    const d = (p.px - mx) ** 2 + (p.py - my) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/* ---- curve (ROC / PR) ---------------------------------------------------------------------------------- */

function CurveView({ c, width }: { c: CurveChart; width: number }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const height = Math.round(Math.min(420, Math.max(240, width * 0.62)));
  const all = c.series.flatMap((s) => s.points);
  const xd = extent(all.map((p) => p[0]));
  const yd = extent(all.map((p) => p[1]));
  const unit = xd[0] >= 0 && xd[1] <= 1 && yd[0] >= 0 && yd[1] <= 1;
  const xDomain: [number, number] = unit ? [0, 1] : padDomain(xd[0], xd[1], 0.04);
  const yDomain: [number, number] = unit ? [0, 1.02] : padDomain(yd[0], yd[1], 0.06);
  return (
    <>
      <Frame
        width={width}
        height={height}
        xDomain={xDomain}
        yDomain={yDomain}
        xLabel={c.xLabel}
        yLabel={c.yLabel}
        label={`${c.title}: ${c.series.map((s) => s.name).join(", ")}`}
        hover={hover}
        onLeave={() => setHover(null)}
        onMove={(mx, my) => {
          const m = marg(width);
          const x = linear(xDomain[0], xDomain[1], m.left, width - m.right);
          const y = linear(yDomain[0], yDomain[1], height - m.bottom, m.top);
          const flat = c.series.flatMap((s, si) => s.points.map((p) => ({ px: x(p[0]), py: y(p[1]), p, si })));
          const i = nearest(flat, mx, my);
          if (i < 0) return setHover(null);
          const f = flat[i];
          setHover({
            x: f.px,
            y: f.py,
            lines: [
              <span key="n" className="text-[var(--lp-ink-3)]">
                {c.series[f.si].name}
              </span>,
              `${c.xLabel || "x"} ${fmtNum(f.p[0], 3)}`,
              `${c.yLabel || "y"} ${fmtNum(f.p[1], 3)}`,
            ],
          });
        }}
      >
        {(x, y) => (
          <>
            {c.diagonal && (
              <line className="fx-fade" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--lp-ink-3)" strokeDasharray="4 4" strokeOpacity={0.7} />
            )}
            {c.series.map((s, i) => (
              <path
                key={s.name + i}
                className="fx-stroke"
                style={at(i)}
                pathLength={1}
                d={path(s.points, x, y)}
                fill="none"
                stroke={SERIES[i % SERIES.length]}
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </>
        )}
      </Frame>
      <Legend items={c.series.map((s, i) => ({ name: s.name, color: SERIES[i % SERIES.length] }))} diagonal={c.diagonal} />
    </>
  );
}

function Legend({ items, diagonal, extra }: { items: { name: string; color: string; hollow?: boolean }[]; diagonal?: boolean; extra?: ReactNode }) {
  return (
    <ul className="as-legend">
      {items.map((it) => (
        <li key={it.name}>
          <span
            className="as-swatch"
            style={it.hollow ? { border: `1px solid ${it.color}`, background: "transparent" } : { background: it.color }}
            aria-hidden
          />
          {it.name}
        </li>
      ))}
      {diagonal && (
        <li>
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke="var(--lp-ink-3)" strokeDasharray="3 3" />
          </svg>
          reference
        </li>
      )}
      {extra}
    </ul>
  );
}

/* ---- scatter (predicted vs actual) --------------------------------------------------------------------- */

function ScatterView({ c, width }: { c: ScatterChart; width: number }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const height = Math.round(Math.min(420, Math.max(240, width * 0.62)));
  const [lo, hi] = extent(c.points.flatMap((p) => (c.diagonal ? [p[0], p[1]] : [])));
  const xd = c.diagonal ? ([lo, hi] as [number, number]) : extent(c.points.map((p) => p[0]));
  const yd = c.diagonal ? ([lo, hi] as [number, number]) : extent(c.points.map((p) => p[1]));
  const xDomain = padDomain(xd[0], xd[1], 0.05);
  const yDomain = padDomain(yd[0], yd[1], 0.05);
  const r = c.points.length > 600 ? 1.6 : 2.4;
  return (
    <>
      <Frame
        width={width}
        height={height}
        xDomain={xDomain}
        yDomain={yDomain}
        xLabel={c.xLabel}
        yLabel={c.yLabel}
        label={`${c.title}: ${c.points.length} points`}
        hover={hover}
        onLeave={() => setHover(null)}
        onMove={(mx, my) => {
          const x = linear(xDomain[0], xDomain[1], marg(width).left, width - M.right);
          const y = linear(yDomain[0], yDomain[1], height - M.bottom, M.top);
          const flat = c.points.map((p) => ({ px: x(p[0]), py: y(p[1]), p }));
          const i = nearest(flat, mx, my, 24);
          if (i < 0) return setHover(null);
          const f = flat[i];
          setHover({ x: f.px, y: f.py, lines: [`${c.xLabel || "x"} ${fmtNum(f.p[0], 4)}`, `${c.yLabel || "y"} ${fmtNum(f.p[1], 4)}`] });
        }}
      >
        {(x, y) => (
          <>
            {c.diagonal && <line x1={x(xDomain[0])} y1={y(xDomain[0])} x2={x(xDomain[1])} y2={y(xDomain[1])} stroke="var(--lp-ink-3)" strokeDasharray="4 4" />}
            <g className="fx-wipe">
              {c.points.map((p, i) => (
                <circle key={i} cx={x(p[0])} cy={y(p[1])} r={r} fill="var(--lp-signal)" fillOpacity={0.55} />
              ))}
            </g>
          </>
        )}
      </Frame>
      <Legend items={[{ name: `${c.points.length.toLocaleString("en-US")} rows`, color: "var(--lp-signal)" }]} diagonal={c.diagonal} />
    </>
  );
}

/* ---- histogram (residuals) ----------------------------------------------------------------------------- */

function HistogramView({ c, width }: { c: HistogramChart; width: number }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const height = Math.round(Math.min(380, Math.max(220, width * 0.55)));
  const xDomain: [number, number] = [Math.min(...c.bins.map((b) => b.x0)), Math.max(...c.bins.map((b) => b.x1))];
  const yMax = Math.max(1, ...c.bins.map((b) => b.count));
  const yDomain: [number, number] = [0, yMax * 1.08];
  const total = c.bins.reduce((a, b) => a + b.count, 0);
  return (
    <>
      <Frame
        width={width}
        height={height}
        xDomain={xDomain}
        yDomain={yDomain}
        xLabel={c.xLabel}
        yLabel="Count"
        yTickFmt={(v) => String(Math.round(v))}
        label={`${c.title}: ${c.bins.length} bins, ${total} rows`}
        hover={hover}
        onLeave={() => setHover(null)}
        onMove={(mx) => {
          const x = linear(xDomain[0], xDomain[1], marg(width).left, width - M.right);
          const y = linear(yDomain[0], yDomain[1], height - M.bottom, M.top);
          const b = c.bins.find((b) => mx >= x(b.x0) && mx <= x(b.x1));
          if (!b) return setHover(null);
          setHover({ x: (x(b.x0) + x(b.x1)) / 2, y: y(b.count), lines: [`${fmtNum(b.x0, 3)} to ${fmtNum(b.x1, 3)}`, `${b.count} rows`] });
        }}
      >
        {(x, y) => (
          <>
            {c.bins.map((b, i) => (
              <rect
                key={i}
                className="fx-bar"
                style={at(i)}
                x={x(b.x0) + 0.5}
                width={Math.max(0.5, x(b.x1) - x(b.x0) - 1)}
                y={y(b.count)}
                height={Math.max(0, y(0) - y(b.count))}
                fill="var(--lp-signal)"
                fillOpacity={b.x0 <= 0 && b.x1 >= 0 ? 0.85 : 0.5}
                rx={1}
              />
            ))}
            {xDomain[0] < 0 && xDomain[1] > 0 && <line x1={x(0)} x2={x(0)} y1={y(yDomain[1])} y2={y(0)} stroke="var(--lp-ink-3)" strokeDasharray="4 4" />}
          </>
        )}
      </Frame>
      <Legend items={[{ name: `${total.toLocaleString("en-US")} rows`, color: "var(--lp-signal)" }]} />
    </>
  );
}

/* ---- matrix (confusion) -------------------------------------------------------------------------------- */

function MatrixView({ c, width }: { c: MatrixChart; width: number }) {
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const n = c.labels.length;
  const max = Math.max(1, ...c.matrix.flat());
  const total = c.matrix.flat().reduce((a, b) => a + b, 0);
  const left = 92;
  const top = 8;
  const bottom = 56;
  const side = Math.max(160, Math.min(width - left - 12, 440));
  const cell = side / n;
  const height = top + side + bottom;
  const short = (s: string) => (s.length > 10 ? `${s.slice(0, 9)}…` : s);
  const correct = c.matrix.reduce((a, row, i) => a + (row[i] ?? 0), 0);
  return (
    <>
      <svg
        width={left + side + 12}
        height={height}
        role="img"
        aria-label={`${c.title}: ${n} classes, ${correct} of ${total} correct`}
        className="mx-auto block max-w-full"
      >
        {c.matrix.map((row, i) =>
          row.map((v, j) => {
            const t = v / max;
            const on = hover && hover.i === i && hover.j === j;
            return (
              <g key={`${i}-${j}`} onPointerEnter={() => setHover({ i, j })} onPointerLeave={() => setHover(null)}>
                <rect
                  className="fx-cell"
                  style={at(i + j)}
                  x={left + j * cell + 1}
                  y={top + i * cell + 1}
                  width={cell - 2}
                  height={cell - 2}
                  rx={4}
                  fill={`rgb(var(--lp-signal-rgb) / ${(0.04 + 0.78 * t).toFixed(3)})`}
                  stroke={on ? "var(--lp-ink)" : "var(--lp-hair)"}
                />
                {cell >= 26 && (
                  <text
                    x={left + j * cell + cell / 2}
                    y={top + i * cell + cell / 2}
                    dy="0.34em"
                    textAnchor="middle"
                    className="as-cell"
                    fill={t > 0.55 ? "var(--lp-on-ink)" : "var(--lp-ink)"}
                  >
                    {v}
                  </text>
                )}
              </g>
            );
          }),
        )}
        {c.labels.map((l, i) => (
          <text key={`r${i}`} x={left - 8} y={top + i * cell + cell / 2} dy="0.32em" textAnchor="end" className="as-tick">
            {short(l)}
          </text>
        ))}
        {c.labels.map((l, j) => (
          <text key={`c${j}`} x={left + j * cell + cell / 2} y={top + side + 16} textAnchor="middle" className="as-tick">
            {short(l)}
          </text>
        ))}
        <text x={left + side / 2} y={height - 8} textAnchor="middle" className="as-axis">
          Predicted
        </text>
        <text transform={`translate(12 ${top + side / 2}) rotate(-90)`} textAnchor="middle" className="as-axis">
          Actual
        </text>
      </svg>
      <p className="as-readout text-center" aria-live="polite">
        {hover
          ? `Actual ${c.labels[hover.i]}, predicted ${c.labels[hover.j]}: ${c.matrix[hover.i][hover.j]} rows`
          : `${correct.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} on the diagonal (${total ? ((100 * correct) / total).toFixed(1) : "0"}% correct)`}
      </p>
    </>
  );
}

/* ---- CV per experiment --------------------------------------------------------------------------------- */

export function CvView({ points, metric, width }: { points: CvPoint[]; metric: Metric | null; width: number }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const height = Math.round(Math.min(380, Math.max(220, width * 0.55)));
  const ys = points.flatMap((p) => [p.mean - p.se, p.mean + p.se]);
  const yd = extent(ys);
  const yDomain = padDomain(yd[0], yd[1], 0.12);
  const xDomain: [number, number] = [-0.5, Math.max(points.length, 2) - 0.5];
  const info = metricInfo(metric);
  return (
    <>
      <Frame
        width={width}
        height={height}
        xDomain={xDomain}
        yDomain={yDomain}
        xLabel="Experiment"
        yLabel={`${info.label} (CV)`}
        xTickFmt={(v) => (Number.isInteger(v) && points[v] ? points[v].id : "")}
        yTickFmt={(v) => fmtNum(toRaw(metric, v), 3)}
        label={`CV ${info.label} per experiment, ${points.length} experiments`}
        hover={hover}
        onLeave={() => setHover(null)}
        onMove={(mx) => {
          const x = linear(xDomain[0], xDomain[1], marg(width).left, width - M.right);
          const y = linear(yDomain[0], yDomain[1], height - M.bottom, M.top);
          const i = nearest(
            points.map((p, i) => ({ px: x(i), py: 0 })),
            mx,
            0,
            Math.max(20, (width - marg(width).left - M.right) / Math.max(points.length, 2) / 2),
          );
          if (i < 0) return setHover(null);
          const p = points[i];
          setHover({
            x: x(i),
            y: y(p.mean),
            lines: [
              <span key="id" className="text-[var(--lp-ink-3)]">
                {p.id} · {p.verdict === "keep" ? "kept" : p.verdict === "crash" ? "broke" : p.verdict ? "not kept" : "pending"}
                {p.best ? " · best" : ""}
              </span>,
              `CV ${formatScore(metric, p.mean)} ± ${fmtNum(p.se, 3)}`,
            ],
          });
        }}
      >
        {(x, y) => (
          <>
            {points.map((p, i) => {
              const kept = p.verdict === "keep";
              const color = kept ? "var(--lp-signal)" : p.verdict === "crash" ? "var(--crash)" : "var(--lp-ink-2)";
              return (
                <g key={p.id} className="fx-pt" style={at(i)}>
                  <line x1={x(i)} x2={x(i)} y1={y(p.mean - p.se)} y2={y(p.mean + p.se)} stroke={color} strokeOpacity={0.5} />
                  <circle cx={x(i)} cy={y(p.mean)} r={p.best ? 5 : 3.75} fill={kept ? color : "var(--lp-page)"} stroke={color} strokeWidth={1.4} />
                </g>
              );
            })}
          </>
        )}
      </Frame>
      <Legend
        items={[
          { name: "kept", color: "var(--lp-signal)" },
          { name: "not kept", color: "var(--lp-ink-2)", hollow: true },
        ]}
        extra={<li className="text-[var(--lp-ink-3)]">bars: ± 1 SE · {info.greaterIsBetter ? "higher" : "lower"} is better</li>}
      />
    </>
  );
}

/** The full chart, sized to its container. */
export function ChartView({ chart, cv, metric }: { chart: AssetChart | "cv"; cv?: CvPoint[]; metric?: Metric | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="as-draw w-full">
      {chart === "cv" ? (
        <CvView points={cv ?? []} metric={metric ?? null} width={width} />
      ) : chart.kind === "curve" ? (
        <CurveView c={chart} width={width} />
      ) : chart.kind === "scatter" ? (
        <ScatterView c={chart} width={width} />
      ) : chart.kind === "histogram" ? (
        <HistogramView c={chart} width={width} />
      ) : (
        <MatrixView c={chart} width={width} />
      )}
    </div>
  );
}

/* ---- thumbnails ---------------------------------------------------------------------------------------- */

/** A tiny, axis-free render for the asset tiles. */
export function ChartThumb({ chart, cv }: { chart: AssetChart | "cv"; cv?: CvPoint[] }) {
  const { w, h } = MINI;
  const pad = 4;
  const sx = (lo: number, hi: number) => linear(lo, hi, pad, w - pad);
  const sy = (lo: number, hi: number) => linear(lo, hi, h - pad, pad);
  let body: ReactNode = null;
  if (chart === "cv") {
    const pts = cv ?? [];
    const [lo, hi] = padDomain(...extent(pts.map((p) => p.mean)), 0.15);
    const x = sx(-0.5, Math.max(pts.length, 2) - 0.5);
    const y = sy(lo, hi);
    body = pts.map((p, i) => (
      <circle
        key={p.id}
        cx={x(i)}
        cy={y(p.mean)}
        r={2.6}
        fill={p.verdict === "keep" ? "var(--lp-signal)" : "transparent"}
        stroke={p.verdict === "keep" ? "var(--lp-signal)" : "var(--lp-ink-3)"}
      />
    ));
  } else if (chart.kind === "curve") {
    const all = chart.series.flatMap((s) => s.points);
    const xd = extent(all.map((p) => p[0]));
    const yd = extent(all.map((p) => p[1]));
    const x = sx(Math.min(0, xd[0]), Math.max(1, xd[1]));
    const y = sy(Math.min(0, yd[0]), Math.max(1, yd[1]));
    body = (
      <>
        {chart.diagonal && <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--lp-ink-3)" strokeDasharray="2 2" />}
        {chart.series.map((s, i) => (
          <path key={i} d={path(s.points, x, y)} fill="none" stroke={SERIES[i % SERIES.length]} strokeWidth={1.5} />
        ))}
      </>
    );
  } else if (chart.kind === "scatter") {
    const pts = chart.points.length > 160 ? chart.points.filter((_, i) => i % Math.ceil(chart.points.length / 160) === 0) : chart.points;
    const [lo, hi] = extent(pts.flat());
    const x = sx(lo, hi);
    const y = sy(lo, hi);
    body = (
      <>
        {chart.diagonal && <line x1={x(lo)} y1={y(lo)} x2={x(hi)} y2={y(hi)} stroke="var(--lp-ink-3)" strokeDasharray="2 2" />}
        {pts.map((p, i) => (
          <circle key={i} cx={x(p[0])} cy={y(p[1])} r={1.2} fill="var(--lp-signal)" fillOpacity={0.6} />
        ))}
      </>
    );
  } else if (chart.kind === "histogram") {
    const lo = Math.min(...chart.bins.map((b) => b.x0));
    const hi = Math.max(...chart.bins.map((b) => b.x1));
    const max = Math.max(1, ...chart.bins.map((b) => b.count));
    const x = sx(lo, hi);
    const y = sy(0, max);
    body = chart.bins.map((b, i) => (
      <rect
        key={i}
        x={x(b.x0) + 0.4}
        width={Math.max(0.5, x(b.x1) - x(b.x0) - 0.8)}
        y={y(b.count)}
        height={y(0) - y(b.count)}
        fill="var(--lp-signal)"
        fillOpacity={0.6}
      />
    ));
  } else {
    const n = chart.labels.length;
    const max = Math.max(1, ...chart.matrix.flat());
    const side = h - pad * 2;
    const cell = side / n;
    const x0 = (w - side) / 2;
    body = chart.matrix.map((row, i) =>
      row.map((v, j) => (
        <rect
          key={`${i}-${j}`}
          x={x0 + j * cell + 0.75}
          y={pad + i * cell + 0.75}
          width={cell - 1.5}
          height={cell - 1.5}
          rx={1.5}
          fill={`rgb(var(--lp-signal-rgb) / ${(0.06 + 0.8 * (v / max)).toFixed(3)})`}
        />
      )),
    );
  }
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="as-thumb" aria-hidden preserveAspectRatio="xMidYMid meet">
      {body}
    </svg>
  );
}
