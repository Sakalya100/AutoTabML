/** Small, dependency-free scale helpers for the SVG charts. */

export function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

/** Evenly spaced "nice" ticks covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.05 || 1;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep(hi - lo, target);
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Number((Math.round(v / step) * step).toPrecision(12)));
  return out;
}

export function linear(d0: number, d1: number, r0: number, r1: number) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

/** Pad a [lo, hi] domain by a fraction of its span (at least `minPad`). */
export function padDomain(lo: number, hi: number, frac = 0.08, minPad = 1e-4): [number, number] {
  const pad = Math.max((hi - lo) * frac, minPad);
  return [lo - pad, hi + pad];
}
