/**
 * The mapped surface: a CPU heightfield that passes (near-)exactly through every scored probe.
 *
 *   h(x) = base(x) + Σ w_i · φ(|x − c_i|),   φ(r) = exp(−r² / 2σ²)
 *
 * with the weights solved from (K + λI) w = y − base(c) so the surface interpolates the real heights, plus a gentle,
 * deterministic relief (value-noise fbm) that fades out near probes so it never moves a measured height.
 * A second channel is the reveal mask: each probe uncovers a disc of ground; everything else is void.
 *
 * Pure (no three.js). Output is one interleaved Float32Array [h, mask] of res² texels, written in place.
 * Texel (i, j) sits at x = minX + i/(res−1)·size, z = minZ + j/(res−1)·size — so a (res−1)-segment plane's vertex
 * k samples texel k exactly.
 */
import type { SurveyLayout } from "./contract";

export const SIGMA = 1.65;
export const LAMBDA = 0.012;
/** Window padding around the mapped bounds (world units). */
export const PAD = 9;
/** Reveal radius around a probe; kept probes reveal more ground. */
export const REVEAL_R = 3.4;
export const REVEAL_R_KEEP = 4.4;
export const RELIEF = 0.42;
export const GROUND_Y = 0;

export interface FieldWindow {
  res: number;
  minX: number;
  minZ: number;
  size: number;
}

/** Square window centred on the mapped bounds (use the domain bounds so it never moves during playback). */
export function fieldWindow(bounds: SurveyLayout["bounds"], res: number): FieldWindow {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) + PAD * 2;
  return { res, minX: cx - size / 2, minZ: cz - size / 2, size };
}

/* ---- deterministic value noise ---- */
function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
/** Ridged-ish fbm in [-1, 1]-ish. */
export function relief(x: number, z: number): number {
  let s = 0;
  let amp = 0.55;
  let f = 0.16;
  for (let o = 0; o < 4; o++) {
    const n = vnoise(x * f + o * 17.3, z * f - o * 9.1) * 2 - 1;
    s += amp * (o === 0 ? n : 1 - Math.abs(n) * 2);
    amp *= 0.48;
    f *= 2.07;
  }
  return s;
}

function baseAt(x: number, z: number): number {
  return GROUND_Y + RELIEF * relief(x, z);
}

/** Solve A x = b in place (Gaussian elimination with partial pivoting). n ≤ a few hundred. */
function solve(A: Float64Array, b: Float64Array, n: number): Float64Array {
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        const t = A[c * n + k];
        A[c * n + k] = A[piv * n + k];
        A[piv * n + k] = t;
      }
      const t = b[c];
      b[c] = b[piv];
      b[piv] = t;
    }
    const d = A[c * n + c] || 1e-9;
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / (A[r * n + r] || 1e-9);
  }
  return x;
}

export interface FieldSource {
  x: number;
  z: number;
  y: number;
  reveal: number;
}

export function fieldSources(layout: SurveyLayout): { centers: FieldSource[]; reveals: FieldSource[] } {
  const centers: FieldSource[] = [];
  const reveals: FieldSource[] = [];
  for (const p of layout.probes) {
    const r = p.status === "keep" ? REVEAL_R_KEEP : REVEAL_R;
    reveals.push({ x: p.pos[0], z: p.pos[2], y: p.pos[1], reveal: r });
    if (p.score01 != null) centers.push({ x: p.pos[0], z: p.pos[2], y: p.pos[1], reveal: r });
  }
  return { centers, reveals };
}

const baseCache = new Map<string, Float32Array>();
function baseGrid(w: FieldWindow): Float32Array {
  const key = `${w.res}:${w.minX.toFixed(3)}:${w.minZ.toFixed(3)}:${w.size.toFixed(3)}`;
  let g = baseCache.get(key);
  if (g) return g;
  g = new Float32Array(w.res * w.res);
  const k = w.size / (w.res - 1);
  for (let j = 0; j < w.res; j++) for (let i = 0; i < w.res; i++) g[j * w.res + i] = baseAt(w.minX + i * k, w.minZ + j * k);
  if (baseCache.size > 6) baseCache.clear();
  baseCache.set(key, g);
  return g;
}

/**
 * Write the heightfield + reveal mask for `layout` into `out` (length res²·2). Returns `out`.
 * Cost: one n×n solve plus a 3σ stamp per probe over the grid.
 */
export function buildHeightfield(layout: SurveyLayout, w: FieldWindow, out?: Float32Array): Float32Array {
  const { res } = w;
  const N = res * res;
  const field = out && out.length === N * 2 ? out : new Float32Array(N * 2);
  const base = baseGrid(w);
  const { centers, reveals } = fieldSources(layout);
  const n = centers.length;
  const inv2s2 = 1 / (2 * SIGMA * SIGMA);

  // Accumulators: Σ w φ (height) and Σ φ (to fade the relief near probes); reveal = max disc.
  const acc = new Float32Array(N);
  const cover = new Float32Array(N);
  const mask = new Float32Array(N);

  if (n > 0) {
    const A = new Float64Array(n * n);
    const b = new Float64Array(n);
    // Relief is faded near probes, so the target the RBF must hit is the probe height minus the faded base.
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const dx = centers[r].x - centers[c].x;
        const dz = centers[r].z - centers[c].z;
        A[r * n + c] = Math.exp(-(dx * dx + dz * dz) * inv2s2) + (r === c ? LAMBDA : 0);
      }
      b[r] = centers[r].y - GROUND_Y;
    }
    const wts = solve(A, b, n);
    const k = (res - 1) / w.size;
    const R = SIGMA * 3.2;
    for (let p = 0; p < n; p++) {
      const c = centers[p];
      const i0 = Math.max(0, Math.floor((c.x - R - w.minX) * k));
      const i1 = Math.min(res - 1, Math.ceil((c.x + R - w.minX) * k));
      const j0 = Math.max(0, Math.floor((c.z - R - w.minZ) * k));
      const j1 = Math.min(res - 1, Math.ceil((c.z + R - w.minZ) * k));
      const wp = wts[p];
      for (let j = j0; j <= j1; j++) {
        const z = w.minZ + j / k;
        const dz2 = (z - c.z) * (z - c.z);
        for (let i = i0; i <= i1; i++) {
          const x = w.minX + i / k;
          const ph = Math.exp(-((x - c.x) * (x - c.x) + dz2) * inv2s2);
          const t = j * res + i;
          acc[t] += wp * ph;
          cover[t] += ph;
        }
      }
    }
  }
  {
    const k = (res - 1) / w.size;
    for (const s of reveals) {
      const R = s.reveal;
      const i0 = Math.max(0, Math.floor((s.x - R - w.minX) * k));
      const i1 = Math.min(res - 1, Math.ceil((s.x + R - w.minX) * k));
      const j0 = Math.max(0, Math.floor((s.z - R - w.minZ) * k));
      const j1 = Math.min(res - 1, Math.ceil((s.z + R - w.minZ) * k));
      for (let j = j0; j <= j1; j++) {
        const z = w.minZ + j / k;
        for (let i = i0; i <= i1; i++) {
          const x = w.minX + i / k;
          const d = Math.hypot(x - s.x, z - s.z) / R;
          if (d >= 1) continue;
          const m = 1 - d * d * (3 - 2 * d); // smoothstep(1, 0, d)
          const t = j * res + i;
          if (m > mask[t]) mask[t] = m;
        }
      }
    }
  }

  const lo = GROUND_Y - 1.2;
  let hi = GROUND_Y + 1;
  for (const c of centers) hi = Math.max(hi, c.y + 0.08);
  // Soft ceiling: the interpolant may overshoot between a cluster of near-equal highs; it saturates smoothly at the
  // summit instead (a plateau — which is also what a saturating run looks like).
  const soft = 0.35;
  for (let t = 0; t < N; t++) {
    const fade = Math.max(0, 1 - cover[t] * 1.6);
    let h = GROUND_Y + acc[t] + (base[t] - GROUND_Y) * fade;
    if (h > hi - soft) h = hi - soft * Math.exp(-(h - (hi - soft)) / soft);
    field[t * 2] = h < lo ? lo : h;
    field[t * 2 + 1] = mask[t];
  }
  return field;
}

/** Bilinear CPU sample of the height channel at world (x, z) — matches the GPU displacement. */
export function sampleField(field: Float32Array, w: FieldWindow, x: number, z: number, channel: 0 | 1 = 0): number {
  const { res } = w;
  const fx = Math.min(res - 1, Math.max(0, ((x - w.minX) / w.size) * (res - 1)));
  const fz = Math.min(res - 1, Math.max(0, ((z - w.minZ) / w.size) * (res - 1)));
  const i = Math.min(res - 2, Math.floor(fx));
  const j = Math.min(res - 2, Math.floor(fz));
  const u = fx - i;
  const v = fz - j;
  const at = (a: number, b: number) => field[(b * res + a) * 2 + channel];
  return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
}
