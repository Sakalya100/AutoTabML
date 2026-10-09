"use client";

/*
 * Activity per day: one smooth line over a fill that fades to the void. The line draws itself in when the chart
 * first scrolls into view; switching Runs / Experiments / Cost (or the range) morphs the curve and its scale from the
 * old values to the new ones. Hover (or arrow keys) shows a crosshair and the day's numbers. A hidden table carries
 * the same data for screen readers.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtCompact, fmtUsd, monotonePath, niceMax, type DashDay } from "@/lib/dashboard";
import { gsap, prefersReducedMotion, ScrollTrigger } from "@/lib/motion/gsap";
import { Segmented } from "./motion";

type Key = "runs" | "experiments" | "equivCostUsd";
const KEYS: { value: Key; label: string; one: string; many: string }[] = [
  { value: "runs", label: "Runs", one: "run", many: "runs" },
  { value: "experiments", label: "Experiments", one: "experiment", many: "experiments" },
  { value: "equivCostUsd", label: "Cost", one: "≈ cost", many: "≈ cost" },
];

const H = 260;
const PAD = { l: 40, r: 12, t: 16, b: 28 };

/** A top for three even gridlines: whole steps for counts, round steps for money. */
function axisMax(k: Key, v: number): number {
  const step = niceMax(v / 3);
  return k === "equivCostUsd" ? step * 3 : Math.max(1, Math.ceil(step)) * 3;
}

const fmtAxis = (k: Key, v: number) => (k === "equivCostUsd" ? (v === 0 ? "$0" : `$${Number(v.toPrecision(3))}`) : fmtCompact(v));
const fmtVal = (k: Key, v: number) => (k === "equivCostUsd" ? `≈ ${fmtUsd(v)}` : fmtCompact(v));
const dayLabel = (d: string, long = false) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });

export function ActivityChart({ series }: { series: DashDay[] }) {
  const [key, setKey] = useState<Key>("runs");
  const wrap = useRef<HTMLDivElement>(null);
  const line = useRef<SVGPathElement>(null);
  const area = useRef<SVGPathElement>(null);
  const glow = useRef<SVGPathElement>(null);
  const dots = useRef<SVGGElement>(null);
  const yTicks = useRef<SVGGElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const shown = useRef<{ vals: number[]; max: number } | null>(null);
  const drawn = useRef(false);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  const vals = useMemo(() => series.map((d) => d[key]), [series, key]);
  const target = useMemo(() => ({ vals, max: axisMax(key, Math.max(...vals, 0)) }), [vals, key]);
  const iw = Math.max(1, w - PAD.l - PAD.r);
  const ih = H - PAD.t - PAD.b;
  const xAt = (i: number, n = vals.length) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);

  // Draw (or morph to) the target curve, writing the path attributes straight to the DOM.
  useLayoutEffect(() => {
    if (!w || !line.current || !area.current) return;
    const L = line.current;
    const A = area.current;
    const render = (v: number[], max: number) => {
      const pts = v.map((y, i) => ({ x: xAt(i, v.length), y: PAD.t + ih - (y / max) * ih }));
      const d = monotonePath(pts);
      L.setAttribute("d", d);
      glow.current?.setAttribute("d", d);
      dots.current?.querySelectorAll<SVGCircleElement>("circle").forEach((c, i) => {
        const p = pts[i];
        if (!p) return;
        c.setAttribute("cx", String(p.x));
        c.setAttribute("cy", String(p.y));
        c.setAttribute("r", v[i] > 0.001 ? "2.6" : "0");
      });
      A.setAttribute("d", pts.length ? `${d}L${pts[pts.length - 1].x},${PAD.t + ih}L${pts[0].x},${PAD.t + ih}Z` : "");
      const g = yTicks.current;
      if (g) {
        g.querySelectorAll<SVGTextElement>("text").forEach((t, k) => {
          t.textContent = fmtAxis(key, (max * (3 - k)) / 3);
        });
      }
    };
    const prev = shown.current;
    const reduce = prefersReducedMotion();
    // Same length (key or range with the same days): morph; otherwise start from the baseline.
    const from = prev && prev.vals.length === target.vals.length ? prev : { vals: target.vals.map(() => 0), max: target.max };
    if (reduce || !drawn.current) {
      render(target.vals, target.max);
      shown.current = target;
      return;
    }
    const o = { t: 0 };
    const tw = gsap.to(o, {
      t: 1,
      duration: 0.9,
      ease: "expo.out",
      onUpdate: () => {
        const v = target.vals.map((y, i) => from.vals[i] + (y - from.vals[i]) * o.t);
        const max = from.max + (target.max - from.max) * o.t;
        shown.current = { vals: v, max };
        render(v, max);
      },
    });
    return () => {
      tw.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, w]);

  // The first draw: the line traces itself in, the fill rises after it.
  useEffect(() => {
    const L = line.current;
    const A = area.current;
    if (!L || !A || !w || drawn.current) return;
    if (prefersReducedMotion()) {
      drawn.current = true;
      return;
    }
    const G = glow.current;
    gsap.set([L, G], { strokeDasharray: 1, strokeDashoffset: 1 });
    gsap.set([A, dots.current], { opacity: 0 });
    const st = ScrollTrigger.create({
      trigger: wrap.current,
      start: "top 85%",
      once: true,
      onEnter: () => {
        gsap.to([L, G], {
          strokeDashoffset: 0,
          duration: 1.8,
          ease: "power2.inOut",
          onComplete: () => void gsap.set([L, G], { clearProps: "strokeDasharray,strokeDashoffset" }),
        });
        gsap.to(A, { opacity: 1, duration: 1.4, delay: 0.6, ease: "power2.out" });
        gsap.to(dots.current, { opacity: 1, duration: 0.6, delay: 1.5, ease: "power2.out" });
        drawn.current = true;
      },
    });
    return () => st.kill();
  }, [w]);

  const n = series.length;
  const total = vals.reduce((a, b) => a + b, 0);
  const peak = vals.reduce((m, v, i) => (v > vals[m] ? i : m), 0);
  const meta = KEYS.find((k) => k.value === key)!;
  const xLabels = n ? [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1].filter((v, i, a) => a.indexOf(v) === i) : [];

  const pick = (clientX: number) => {
    const el = wrap.current;
    if (!el || n === 0) return;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left - PAD.l;
    setHover(Math.max(0, Math.min(n - 1, Math.round((x / iw) * (n - 1)))));
  };
  const hv = hover != null ? series[hover] : null;
  const hy = hover != null ? PAD.t + ih - (vals[hover] / target.max) * ih : 0;

  return (
    <section className="dash-card dash-activity" aria-labelledby="dash-act-h">
      <div className="dash-card-head">
        <div>
          <h2 id="dash-act-h" className="dash-h2">
            Activity
          </h2>
          <p className="dash-card-sub">
            <span className="dash-mono">{fmtVal(key, total)}</span> {key === "equivCostUsd" ? "in equivalent tokens" : total === 1 ? meta.one : meta.many} over{" "}
            {n} days
            {total > 0 ? <> · busiest {dayLabel(series[peak].date)}</> : null}
          </p>
        </div>
        <Segmented label="Activity measure" size="sm" value={key} onChange={setKey} options={KEYS.map((k) => ({ value: k.value, label: k.label }))} />
      </div>
      <div
        ref={wrap}
        className="dash-act-plot"
        role="img"
        aria-label={`${meta.label} per day over ${n} days: ${fmtVal(key, total)} in total.`}
        tabIndex={0}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          setHover((h) => Math.max(0, Math.min(n - 1, (h ?? n - 1) + (e.key === "ArrowRight" ? 1 : -1))));
        }}
      >
        <svg width={w || "100%"} height={H} className="dash-act-svg" aria-hidden>
          <defs>
            <linearGradient id="dash-act-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--lp-signal)" stopOpacity="0.26" />
              <stop offset="0.55" stopColor="var(--lp-signal)" stopOpacity="0.06" />
              <stop offset="1" stopColor="var(--lp-signal)" stopOpacity="0" />
            </linearGradient>
            <filter id="dash-act-glow" x="-10%" y="-30%" width="120%" height="160%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
          </defs>
          <g ref={yTicks} className="dash-axis">
            {[0, 1, 2, 3].map((k) => (
              <g key={k} transform={`translate(0 ${PAD.t + (ih * k) / 3})`}>
                <line x1={PAD.l} x2={w - PAD.r} className={k === 3 ? "dash-base" : "dash-gridline"} />
                <text x={PAD.l - 10} dy="0.32em" textAnchor="end">
                  {fmtAxis(key, (target.max * (3 - k)) / 3)}
                </text>
              </g>
            ))}
          </g>
          <g className="dash-axis">
            {xLabels.map((i) => (
              <text key={i} x={xAt(i, n)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
                {dayLabel(series[i].date)}
              </text>
            ))}
          </g>
          <path ref={area} fill="url(#dash-act-fill)" />
          <path ref={glow} className="dash-act-glow" fill="none" filter="url(#dash-act-glow)" pathLength={1} />
          <path ref={line} className="dash-act-line" fill="none" pathLength={1} />
          <g ref={dots} className="dash-act-dots">
            {series.map((d) => (
              <circle key={d.date} r={0} />
            ))}
          </g>
          {hv ? (
            <g className="dash-cross">
              <line x1={xAt(hover!, n)} x2={xAt(hover!, n)} y1={PAD.t} y2={PAD.t + ih} />
              <circle cx={xAt(hover!, n)} cy={hy} r={9} className="dash-cross-halo" />
              <circle cx={xAt(hover!, n)} cy={hy} r={4} className="dash-cross-dot" />
            </g>
          ) : null}
        </svg>
        {hv ? (
          <div
            className="dash-tt"
            style={{
              transform: `translate(${xAt(hover!, n) > w / 2 ? xAt(hover!, n) - 160 - 18 : xAt(hover!, n) + 18}px, ${Math.min(Math.max(0, hy - 48), H - PAD.b - 100)}px)`,
            }}
          >
            <p className="dash-tt-date">{dayLabel(hv.date, true)}</p>
            <p className="dash-tt-row">
              <span>Runs</span>
              <b>{hv.runs}</b>
            </p>
            <p className="dash-tt-row">
              <span>Experiments</span>
              <b>{hv.experiments}</b>
            </p>
            <p className="dash-tt-row">
              <span>≈ Cost</span>
              <b>{fmtUsd(hv.equivCostUsd)}</b>
            </p>
          </div>
        ) : null}
      </div>
      <table className="sr-only">
        <caption>Activity per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Runs</th>
            <th scope="col">Experiments</th>
            <th scope="col">Equivalent cost</th>
          </tr>
        </thead>
        <tbody>
          {series.map((d) => (
            <tr key={d.date}>
              <th scope="row">{d.date}</th>
              <td>{d.runs}</td>
              <td>{d.experiments}</td>
              <td>{fmtUsd(d.equivCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
