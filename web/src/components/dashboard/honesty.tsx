"use client";

/*
 * "Did it fool itself?": each finished run's own cross-validated estimate (x) against the score it got on the locked
 * test it never saw (y). On the diagonal the estimate was exact; below it the test came out worse. Every metric sits
 * on its own scale (lib/dashboard honestyPoints), so the diagonal means the same thing for all of them.
 * Colour and shape both carry the metric (three validated hues, then "other"), so identity is never colour alone.
 */
import { useRef, useState } from "react";
import { fmtGap, fmtScore, honestyPoints, honestySentence, type DashQuality } from "@/lib/dashboard";
import { metricInfo } from "@/lib/metrics";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion/gsap";

/** Validated for a dark surface, all pairs (dataviz validator): blue, aqua, coral; then a neutral "other". */
const HUES = ["#3987e5", "#199e70", "#e66767"] as const;
const OTHER = "oklch(70% 0.01 85)";
export type Shape = "circle" | "square" | "diamond" | "triangle";
const SHAPES: Shape[] = ["circle", "square", "diamond"];

export interface MetricStyle {
  color: string;
  shape: Shape;
  label: string;
}

/** Colour follows the metric, in the order of the account's metric mix (most-used first), never the chart's rank. */
export function metricStyles(order: string[]): (m: string) => MetricStyle {
  const known = new Map(order.slice(0, 3).map((m, i) => [m, i]));
  return (m) => {
    const i = known.get(m);
    return i == null ? { color: OTHER, shape: "triangle", label: metricInfo(m).label } : { color: HUES[i], shape: SHAPES[i], label: metricInfo(m).label };
  };
}

export function Mark({ shape, x, y, r, color, className }: { shape: Shape; x: number; y: number; r: number; color: string; className?: string }) {
  if (shape === "square") return <rect x={x - r * 0.88} y={y - r * 0.88} width={r * 1.76} height={r * 1.76} rx={1.5} fill={color} className={className} />;
  if (shape === "diamond")
    return <path d={`M${x},${y - r * 1.2}L${x + r * 1.2},${y}L${x},${y + r * 1.2}L${x - r * 1.2},${y}Z`} fill={color} className={className} />;
  if (shape === "triangle")
    return <path d={`M${x},${y - r * 1.15}L${x + r * 1.1},${y + r * 0.8}L${x - r * 1.1},${y + r * 0.8}Z`} fill={color} className={className} />;
  return <circle cx={x} cy={y} r={r} fill={color} className={className} />;
}

export function MarkIcon({ s }: { s: MetricStyle }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="dash-mark-icon">
      <Mark shape={s.shape} x={6} y={6} r={4} color={s.color} />
    </svg>
  );
}

const S = 300;
const P = 30;

export function HonestyScatter({ quality, metricOrder }: { quality: DashQuality[]; metricOrder: string[] }) {
  const root = useRef<HTMLElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const style = metricStyles(metricOrder);
  const pts = honestyPoints(quality);
  // Runs that land on the same spot (the same data and result twice) share one mark.
  const spots = new Map<string, typeof pts>();
  for (const p of pts) {
    const k = `${p.u.toFixed(3)}:${p.v.toFixed(3)}:${p.metric}`;
    spots.set(k, [...(spots.get(k) ?? []), p]);
  }
  const raw = [...spots.entries()].map(([k, ps]) => ({ k, ps, p: ps[0], x: P + ps[0].u * (S - 2 * P), y: S - P - ps[0].v * (S - 2 * P) }));
  // Marks of different metrics can land on one spot (each metric has its own scale). Dodge them along the diagonal,
  // which keeps each mark's distance from it, so what the chart says about honesty is unchanged.
  const marks: typeof raw = [];
  for (const m of raw) {
    let { x, y } = m;
    for (let step = 1; step < 8 && marks.some((o) => Math.hypot(o.x - x, o.y - y) < 16); step++) {
      const d = Math.ceil(step / 2) * 12 * (step % 2 ? 1 : -1);
      x = m.x + d;
      y = m.y - d;
    }
    marks.push({ ...m, x, y });
  }
  const used = [...new Set(quality.map((q) => q.metric))];
  const legend = metricOrder.filter((m) => used.includes(m)).concat(used.filter((m) => !metricOrder.includes(m)));
  const hv = marks.find((m) => m.k === hover);

  useGSAP(
    () => {
      if (prefersReducedMotion() || !root.current) return;
      const tl = gsap.timeline({ scrollTrigger: { trigger: root.current, start: "top 82%", once: true } });
      tl.from(".dash-diag", { strokeDashoffset: 1, duration: 1.2, ease: "power2.inOut" })
        .from(".dash-fool", { opacity: 0, duration: 0.9, ease: "power2.out" }, 0.2)
        .from(".dash-pt", { scale: 0, opacity: 0, transformOrigin: "50% 50%", duration: 0.9, ease: EASE.spring, stagger: 0.08 }, 0.5);
    },
    { scope: root, dependencies: [quality.length] },
  );

  return (
    <section ref={root} className="dash-card dash-honesty" aria-labelledby="dash-hon-h">
      <div className="dash-card-head">
        <div>
          <h2 id="dash-hon-h" className="dash-h2">
            Did it fool itself?
          </h2>
          <p className="dash-card-sub">{honestySentence(quality)}</p>
        </div>
      </div>
      <div className="dash-hon-body">
        <div className="dash-hon-plot">
          <svg
            viewBox={`0 0 ${S} ${S}`}
            className="dash-hon-svg"
            role="img"
            aria-label="Each finished run's cross-validated estimate against its locked-test score. Details in the table below."
          >
            <defs>
              <linearGradient id="dash-fool-g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--crash)" stopOpacity="0.0" />
                <stop offset="1" stopColor="var(--crash)" stopOpacity="0.08" />
              </linearGradient>
            </defs>
            <rect x={P} y={P} width={S - 2 * P} height={S - 2 * P} className="dash-hon-frame" />
            <path d={`M${P},${S - P}L${S - P},${S - P}L${S - P},${P}Z`} fill="url(#dash-fool-g)" className="dash-fool" />
            <line x1={P} y1={S - P} x2={S - P} y2={P} className="dash-diag" pathLength={1} />
            <text x={S - P - 6} y={P + 14} textAnchor="end" className="dash-hon-note">
              test = estimate
            </text>
            <text x={S - P - 6} y={S - P - 8} textAnchor="end" className="dash-hon-note dash-hon-note-warn">
              test worse
            </text>
            <text x={S / 2} y={S - 8} textAnchor="middle" className="dash-hon-axis">
              CV estimate →
            </text>
            <text x={10} y={S / 2} textAnchor="middle" transform={`rotate(-90 10 ${S / 2})`} className="dash-hon-axis">
              Locked test →
            </text>
            {marks.map((m) => {
              const s = style(m.p.metric);
              return (
                <g
                  key={m.k}
                  className="dash-pt"
                  data-on={hover === m.k ? "" : undefined}
                  onPointerEnter={() => setHover(m.k)}
                  onPointerLeave={() => setHover((h) => (h === m.k ? null : h))}
                >
                  <circle cx={m.x} cy={m.y} r={14} fill="transparent" />
                  <Mark shape={s.shape} x={m.x} y={m.y} r={hover === m.k ? 6.5 : 5} color={s.color} className="dash-pt-mark" />
                  {m.ps.length > 1 ? <circle cx={m.x} cy={m.y} r={10} className="dash-pt-ring" stroke={s.color} /> : null}
                </g>
              );
            })}
          </svg>
          {hv ? (
            <div className="dash-tt dash-tt-hon" style={{ left: `${(hv.x / S) * 100}%`, top: `${(hv.y / S) * 100}%` }}>
              <p className="dash-tt-date">
                {hv.p.dataset}
                {hv.ps.length > 1 ? ` · ${hv.ps.length} runs` : ""}
              </p>
              <p className="dash-tt-row">
                <span>{style(hv.p.metric).label} · CV</span>
                <b>{fmtScore(hv.p.cv)}</b>
              </p>
              <p className="dash-tt-row">
                <span>Locked test</span>
                <b>{fmtScore(hv.p.test)}</b>
              </p>
              <p className="dash-tt-row">
                <span>Shortfall</span>
                <b data-bad={hv.p.gap > 0 ? "" : undefined}>{fmtGap(hv.p.gap)}</b>
              </p>
            </div>
          ) : null}
        </div>
        <ul className="dash-legend" aria-label="Metrics">
          {legend.map((m) => (
            <li key={m}>
              <MarkIcon s={style(m)} />
              {style(m).label}
            </li>
          ))}
          <li className="dash-legend-note">
            Each metric on its own scale, better toward the top right.
            {marks.some((m) => m.ps.length > 1) ? " A dashed ring: the same result more than once." : ""}
          </li>
        </ul>
      </div>
      <table className="sr-only">
        <caption>Estimate against locked test, per finished run</caption>
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col">Metric</th>
            <th scope="col">CV estimate</th>
            <th scope="col">Locked test</th>
            <th scope="col">Shortfall (positive means the test was worse)</th>
          </tr>
        </thead>
        <tbody>
          {quality.map((q) => (
            <tr key={q.runId}>
              <th scope="row">{q.dataset}</th>
              <td>{metricInfo(q.metric).label}</td>
              <td>{fmtScore(q.cv)}</td>
              <td>{fmtScore(q.test)}</td>
              <td>{fmtGap(q.gap)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
