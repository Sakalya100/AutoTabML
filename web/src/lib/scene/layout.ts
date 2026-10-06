/**
 * Pure, deterministic reef geometry for a RunView. No three.js imports — unit-tested in tests/scene-layout.test.ts.
 *
 * Shape: a coral that climbs from the seabed toward the light.
 *   - Kept experiments form the climbing stems. A kept branch starts at its parent's tip and its tip height is the
 *     oriented CV mean, mapped linearly over the range of *kept* scores onto [SPROUT_Y, CROWN_Y] — so the best
 *     lineage visibly rises toward the surface. A kept branch never points down (a kept simplification that lost a
 *     hair of score still rises a little).
 *   - Discarded / crashed / running experiments are short side-shoots attached along their parent's stem. They
 *     always grow upward; their length grows with their score, but they never reach far: they wither.
 *   - The same height map extrapolates for the fitted ceiling and the select/test scores.
 *
 * Pass `domainView` (the complete run, for replays) to freeze the scale: tips then never move while playback
 * adds experiments one by one. Live runs omit it and the scale follows the kept scores seen so far.
 */
import type { ExpView, RunView } from "@/lib/run-state";
import type { ReefLayout, ReefNode } from "./contract";

export const SEABED_Y = 0;
/** Height of the lowest kept score in the run. */
export const SPROUT_Y = 1.8;
/** Height of the best kept score in the run. */
export const CROWN_Y = 7.2;
/** A kept branch rises at least this much above its parent's tip. */
export const MIN_KEPT_RISE = 0.45;
/** Side-shoot length range (discard/crash/running): stubby for bad ideas, long for near-misses. */
export const SHOOT_LEN: [number, number] = [0.45, 2.6];
/** Minimum rise of any side-shoot (they always grow upward). */
export const MIN_SHOOT_RISE = 0.3;

/**
 * Vigour of a side-shoot in [0, 1]: how close its CV mean came to its parent's. A tie or a non-significant gain is a
 * near-miss (1); falling short by more than ~60% of the run's score span is a bad idea (0).
 */
export function shootVigour(score: number | null, parentScore: number | null, span: number): number {
  if (score == null || parentScore == null || !(span > 0)) return 0.35;
  return clamp01(1 + (score - parentScore) / (0.6 * span));
}
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996 rad

type V3 = [number, number, number];

export interface ReefScale {
  lo: number;
  hi: number;
  /** Oriented score → world height (linear, extrapolates). */
  heightOf: (score: number) => number;
  /** Oriented score difference → world length. */
  lengthOf: (delta: number) => number;
}

/** FNV-1a → [0, 1). Deterministic per id. */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function rangeOf(scores: number[]): [number, number] {
  let lo = scores.length ? Math.min(...scores) : 0;
  let hi = scores.length ? Math.max(...scores) : 1;
  if (!(hi - lo > 1e-12)) {
    // One score (or all equal): centre it, with a span proportional to its magnitude.
    const pad = Math.max(Math.abs(hi) * 0.01, 1e-6);
    lo -= pad;
    hi += pad;
  }
  return [lo, hi];
}

function scores(views: (RunView | null | undefined)[], keptOnly: boolean): number[] {
  const out: number[] = [];
  for (const v of views)
    for (const x of v?.experiments ?? []) if ((!keptOnly || x.status === "keep") && x.cv && Number.isFinite(x.cv.mean)) out.push(x.cv.mean);
  return out;
}

/** Height scale over the kept scores (falls back to every scored experiment before anything is kept). */
export function reefScale(view: RunView, domainView?: RunView | null): ReefScale {
  const kept = scores([domainView, view], true);
  const [lo, hi] = rangeOf(kept.length >= 2 ? kept : scores([domainView, view], false));
  const k = (CROWN_Y - SPROUT_Y) / (hi - lo);
  return { lo, hi, heightOf: (s) => SPROUT_Y + (s - lo) * k, lengthOf: (d) => Math.abs(d) * k };
}

/** The surface asymptote in oriented units, or null if the run has not stopped. */
export function ceilingScore(view: RunView): number | null {
  if (view.phase !== "stopped" && view.phase !== "finished") return null;
  const best = view.experiments.find((x) => x.id === view.bestId);
  const bestMean = best?.cv?.mean ?? best?.bestMeanAfter ?? null;
  if (bestMean == null) return null;
  const sat = view.stop?.signals.find((s) => s.key === "saturation");
  if (typeof sat?.value === "number" && Number.isFinite(sat.value)) return bestMean + Math.max(0, sat.value);
  return bestMean + (best?.cv?.se ?? 0);
}

/**
 * Cubic Bézier control points of a branch: rise straight out of the base first, then arc toward the tip.
 * Shared by the layout (attach points along a parent) and the scene (the tube), so shoots sit on their stem.
 */
export function branchControls(base: readonly number[], tip: readonly number[], seed: number): [V3, V3, V3, V3] {
  const d: V3 = [tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]];
  const len = Math.max(Math.hypot(d[0], d[1], d[2]), 0.05);
  const hl = Math.hypot(d[0], d[2]);
  const side: V3 = hl > 1e-6 ? [-d[2] / hl, 0, d[0] / hl] : [1, 0, 0];
  const wob = (seed - 0.5) * 0.22 * len;
  const p1: V3 = [base[0] + d[0] * 0.04, base[1] + 0.42 * len, base[2] + d[2] * 0.04];
  const p2: V3 = [base[0] + d[0] * 0.72 + side[0] * wob, base[1] + d[1] * 0.72 + 0.1 * len, base[2] + d[2] * 0.72 + side[2] * wob];
  return [[base[0], base[1], base[2]], p1, p2, [tip[0], tip[1], tip[2]]];
}

export function pointOnBranch(base: readonly number[], tip: readonly number[], seed: number, t: number): V3 {
  const [a, b, c, e] = branchControls(base, tip, seed);
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [0, 1, 2].map((i) => w[0] * a[i] + w[1] * b[i] + w[2] * c[i] + w[3] * e[i]) as V3;
}

export function layoutReef(view: RunView, domainView?: RunView | null): ReefLayout {
  const scale = reefScale(view, domainView);
  const [allLo, allHi] = rangeOf(scores([domainView, view], false));
  const byId = new Map(view.experiments.map((x) => [x.id, x]));

  // Best lineage: the best experiment and every ancestor.
  const lineage = new Set<string>();
  for (let id = view.bestId; id && !lineage.has(id); id = byId.get(id)?.parentId ?? null) lineage.add(id);

  const keptSlots = new Map<string, number>();
  const shootSlots = new Map<string, number>();
  let roots = 0;
  const placed = new Map<string, ReefNode>();
  const nodes: ReefNode[] = [];

  for (const x of view.experiments) {
    // Experiments arrive in order, so a parent is always placed before its children.
    const parent = x.parentId ? placed.get(x.parentId) : undefined;
    const seed = hash01(x.id);
    const score = scoreOf(x);
    const kept = x.status === "keep";
    let base: V3;
    let tip: V3;

    if (!parent) {
      // A root (the baseline): straight up out of the seabed.
      const slot = roots++;
      const a = slot * GOLDEN;
      const r = slot === 0 ? 0 : 1.1 * Math.sqrt(slot);
      base = [Math.cos(a) * r, SEABED_Y, Math.sin(a) * r];
      const y = score != null ? Math.max(scale.heightOf(score), SEABED_Y + 1.2) : SEABED_Y + 0.7;
      tip = [base[0] + (seed - 0.5) * 0.3, y, base[2] + (seed - 0.5) * 0.2];
    } else if (kept) {
      // A kept child climbs from its parent's tip, leaning out on a golden-angle spiral.
      const slot = keptSlots.get(parent.id) ?? 0;
      keptSlots.set(parent.id, slot + 1);
      const a = hash01(parent.id) * Math.PI * 2 + slot * GOLDEN;
      const reach = 0.45 + 0.3 * Math.sqrt(slot) + seed * 0.25;
      base = [...parent.tip];
      const y = Math.max(score != null ? scale.heightOf(score) : base[1], base[1] + MIN_KEPT_RISE);
      tip = [base[0] + Math.cos(a) * reach, y, base[2] + Math.sin(a) * reach];
    } else {
      // Side-shoot (discard / crash / running): attached along the parent's stem, short, always upward.
      const slot = shootSlots.get(parent.id) ?? 0;
      shootSlots.set(parent.id, slot + 1);
      const t = 0.28 + 0.56 * frac(0.5 + slot * 0.618034 + hash01(parent.id) * 0.37);
      base = pointOnBranch(parent.base, parent.tip, hash01(parent.id), t);
      // Fan around the stem in 3D: golden angle plus a per-shoot jitter, leaning up 48-64 degrees.
      const a = hash01(parent.id) * Math.PI * 2 + slot * GOLDEN + (seed - 0.5) * 0.5;
      const parentScore = scoreOf(byId.get(parent.id)!);
      const vigour = x.status === "crash" ? 0 : x.status === "running" ? 0.3 : shootVigour(score, parentScore, allHi - allLo);
      const len = SHOOT_LEN[0] + (SHOOT_LEN[1] - SHOOT_LEN[0]) * vigour;
      const el = (48 + 16 * seed) * (Math.PI / 180);
      // Like a coral's side branches, shoots stay below the stem's own tip.
      const room = Math.max(MIN_SHOOT_RISE, parent.tip[1] - base[1] - 0.08);
      const rise = Math.max(MIN_SHOOT_RISE, Math.min(len * Math.sin(el), room));
      const reach = len * Math.cos(el);
      tip = [base[0] + Math.cos(a) * reach, base[1] + rise, base[2] + Math.sin(a) * reach];
    }

    const node: ReefNode = {
      id: x.id,
      parentId: parent ? parent.id : null,
      index: x.index,
      status: x.status,
      radical: !!x.idea?.radical,
      tip: r3(tip),
      base: r3(base),
      score01: score == null ? null : clamp01((score - scale.lo) / (scale.hi - scale.lo)),
      isBest: lineage.has(x.id),
    };
    placed.set(x.id, node);
    nodes.push(node);
  }

  const best = view.bestId ? byId.get(view.bestId) : undefined;
  const reefHeight = Math.max(1, ...nodes.map((n) => n.tip[1] - SEABED_Y));
  const ceiling = ceilingScore(view);
  // Select/test come from other splits and can fall outside the dev-CV range; keep them inside the frame
  // (the labels carry the exact numbers).
  const floor = (y: number) => Math.min(CROWN_Y + 2.4, Math.max(SEABED_Y + 0.15, y));

  return {
    nodes,
    seabedY: SEABED_Y,
    surfaceY: ceiling == null ? null : round(scale.heightOf(ceiling)),
    // The noise band, its diameter never more than 30% of the reef's current height (early SEs are large).
    haloRadius: round(Math.min(0.15 * reefHeight, 1.4, Math.max(0.18, scale.lengthOf(best?.cv?.se ?? 0)))),
    bestId: view.bestId,
    selectY: view.final ? round(floor(scale.heightOf(view.final.selectScore))) : null,
    testY: view.final ? round(floor(scale.heightOf(view.final.testScore))) : null,
  };
}

function scoreOf(x: ExpView): number | null {
  if (x.status === "crash") return null;
  return x.cv && Number.isFinite(x.cv.mean) ? x.cv.mean : null;
}

const frac = (v: number) => v - Math.floor(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 1e6) / 1e6;
const r3 = (p: V3): V3 => [round(p[0]), round(p[1]), round(p[2])];
