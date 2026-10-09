/**
 * Terra Incognita — pure, deterministic survey layout for a RunView. No three.js imports; unit-tested in
 * tests/survey-layout.test.ts against the real replays.
 *
 * Map projection (the only part of the picture that is NOT measured — we say so on the page):
 *   bearing  = the idea's category on an 8-point compass rose, plus a small per-id jitter
 *   step     = how big the change is. The size proxy is `idea.radical` (a radical idea steps further), because it is
 *              known the moment the experiment starts — diffs are not on the client and live runs never have
 *              them, so a diff-based step would draw a different map for the same run on different pages.
 *   origin   = the parent probe (the baseline sits at the origin)
 *   spacing  = probe i is resolved only against probes 0..i-1 (fanning out around its bearing), so a playback
 *              prefix lays out exactly like the full run: positions never move during a scrub.
 * Height is real: the oriented CV mean, mapped linearly over the run's domain (`domainView` for replays).
 */
import type { ExpView, RunView } from "@/lib/run-state";
import type { SurveyLayout, SurveyProbe } from "./contract";

/** World height of the lowest / highest CV mean in the domain. Ground (unexplored) sits at 0. */
export const H_LO = 0.7;
export const H_HI = 3.9;
/** Step from parent: ordinary vs radical change (world units), ±STEP_JITTER. */
export const STEP = 2.9;
export const STEP_RADICAL = 4.6;
export const STEP_JITTER = 0.14;
/** Bearing jitter (radians, ±). */
export const BEARING_JITTER = 0.32;
/** No two probes closer than this on the map (x/z). */
export const MIN_SEP = 1.55;

/** Compass rose: 8 idea categories, 0 = north (−z), clockwise. */
export const BEARINGS: Record<string, number> = {
  hyperparameters: 0,
  model_family: 45,
  feature_engineering: 90,
  preprocessing: 135,
  ensembling: 180,
  simplification: 225,
  repair: 270,
  baseline: 315,
};

type V3 = [number, number, number];

/** FNV-1a → [0, 1). Deterministic per string. */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1000003) / 1000003;
}

/** Bearing (radians) for a category; unknown categories get a stable hashed bearing. */
export function bearingOf(category: string, id: string): number {
  const deg = BEARINGS[category] ?? Math.floor(hash01(`cat:${category}`) * 8) * 45 + 22.5;
  return (deg * Math.PI) / 180 + (hash01(`b:${id}`) * 2 - 1) * BEARING_JITTER;
}

export function stepOf(radical: boolean, id: string): number {
  return (radical ? STEP_RADICAL : STEP) * (1 + (hash01(`s:${id}`) * 2 - 1) * STEP_JITTER);
}

export interface ScoreDomain {
  lo: number;
  hi: number;
}

/** Score range over every scored experiment (oriented CV means). A single score gets a proportional pad. */
export function scoreDomain(v: RunView): ScoreDomain {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of v.experiments) {
    const m = x.cv?.mean;
    if (m == null || !Number.isFinite(m)) continue;
    lo = Math.min(lo, m);
    hi = Math.max(hi, m);
  }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
  if (!(hi - lo > 1e-12)) {
    const pad = Math.max(Math.abs(hi) * 0.01, 1e-6);
    return { lo: lo - pad, hi: hi + pad };
  }
  return { lo, hi };
}

/** Oriented score → world height. Linear and NOT clamped: test scores outside the CV range extrapolate. */
export function heightScale(d: ScoreDomain) {
  const k = (H_HI - H_LO) / (d.hi - d.lo);
  return { heightOf: (s: number) => H_LO + (s - d.lo) * k, unitsPerScore: k };
}

/** "Nice" 1-2-5 contour interval in score units so ~8-14 isolines span the domain. */
export function niceStep(span: number, target = 10): number {
  if (!(span > 0)) return 1;
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** x/z of every experiment, in order. Depends only on ids, parents, categories and the radical flag. */
export function projectPositions(exps: readonly ExpView[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const placed: [number, number][] = [];
  for (const x of exps) {
    const parent = x.parentId ? out.get(x.parentId) : undefined;
    let pos: [number, number];
    if (!parent && placed.length === 0) pos = [0, 0];
    else {
      const o = parent ?? [0, 0];
      const theta = bearingOf(x.idea?.category ?? "unknown", x.id);
      const s = stepOf(!!x.idea?.radical, x.id);
      pos = [o[0] + Math.sin(theta) * s, o[1] - Math.cos(theta) * s];
      // Fan out around the bearing (alternating sides, widening, then stepping further) until clear.
      for (let k = 0; k < 96; k++) {
        const side = k % 2 === 0 ? 1 : -1;
        const fan = Math.ceil(k / 2) * 0.33 * side;
        const reach = s + Math.floor(k / 8) * 0.55;
        const c: [number, number] = [o[0] + Math.sin(theta + fan) * reach, o[1] - Math.cos(theta + fan) * reach];
        if (placed.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) >= MIN_SEP)) {
          pos = c;
          break;
        }
      }
    }
    out.set(x.id, pos);
    placed.push(pos);
  }
  return out;
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

export interface SurveyLayoutFull extends SurveyLayout {
  domain: ScoreDomain;
  /** World units per oriented score unit. */
  unitsPerScore: number;
  /** Contour interval: isolines sit at real score multiples of `scoreStep`; `step`/`base` are in world height. */
  contour: { scoreStep: number; step: number; base: number };
  /** Height of the current best (null before the first keep). */
  bestY: number | null;
}

/**
 * Lay out the survey for a view. Pass `domainView` (the complete run, for replays) to freeze the height scale and
 * the framing bounds, so nothing rescales or re-frames during playback.
 */
export function layoutSurvey(view: RunView, domainView?: RunView | null): SurveyLayoutFull {
  const dom = domainView ?? view;
  const domain = scoreDomain(dom);
  const { heightOf, unitsPerScore } = heightScale(domain);
  const xz = projectPositions(dom.experiments.length >= view.experiments.length ? dom.experiments : view.experiments);
  // A live view can run ahead of a stale domain; project it too (prefix-stable, so shared ids agree).
  const xzNow = view.experiments.every((x) => xz.has(x.id)) ? xz : projectPositions(view.experiments);
  const byId = new Map(view.experiments.map((x) => [x.id, x]));

  const probes: SurveyProbe[] = [];
  const yOf = new Map<string, number>();
  for (const x of view.experiments) {
    const [px, pz] = xzNow.get(x.id) ?? [0, 0];
    const m = x.cv?.mean;
    const scored = m != null && Number.isFinite(m);
    // Unscored (running / crashed): sits on its parent's ground.
    const y = scored ? heightOf(m) : x.parentId && yOf.has(x.parentId) ? yOf.get(x.parentId)! : H_LO;
    yOf.set(x.id, y);
    probes.push({
      id: x.id,
      parentId: x.parentId,
      index: x.index,
      status: x.status,
      category: x.idea?.category ?? "unknown",
      radical: !!x.idea?.radical,
      pos: [px, y, pz],
      score01: scored ? Math.min(1, Math.max(0, (m - domain.lo) / (domain.hi - domain.lo))) : null,
      isBest: x.id === view.bestId,
      onClimbPath: x.status === "keep",
    });
  }

  const climb: V3[] = probes.filter((p) => p.onClimbPath).map((p) => p.pos);
  const bestProbe = probes.find((p) => p.isBest && p.score01 != null) ?? null;
  const bead = bestProbe ? bestProbe.pos : null;
  const best = view.bestId ? byId.get(view.bestId) : undefined;
  const bestMean = best?.cv?.mean ?? null;
  const bestSe = best?.cv?.se ?? null;

  // Framing bounds from the domain (stable during playback).
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity,
    maxY = 0;
  for (const x of dom.experiments) {
    const p = xz.get(x.id);
    if (!p) continue;
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[1]);
    maxZ = Math.max(maxZ, p[1]);
    const m = x.cv?.mean;
    if (m != null && Number.isFinite(m)) maxY = Math.max(maxY, heightOf(m));
  }
  for (const p of probes) {
    minX = Math.min(minX, p.pos[0]);
    maxX = Math.max(maxX, p.pos[0]);
    minZ = Math.min(minZ, p.pos[2]);
    maxZ = Math.max(maxZ, p.pos[2]);
    maxY = Math.max(maxY, p.pos[1]);
  }
  if (!Number.isFinite(minX)) [minX, maxX, minZ, maxZ] = [-1, 1, -1, 1];

  // The noise floor: the best's standard error, in world units.
  const mist = bestSe != null && bestSe > 0 ? bestSe * unitsPerScore : 0;

  // The ceiling: only once the stop rule has fired.
  let cloudY: number | null = null;
  if ((view.phase === "stopped" || view.phase === "finished") && view.stop && bestMean != null) {
    // Best + the gain the fitted curve still predicts, but never closer than the noise floor: a run whose ideas never
    // beat the start predicts no gain, and the ceiling then sat exactly on the ball.
    const sat = num(view.stop.signals.find((s) => s.key === "saturation")?.value);
    const add = Math.max(sat ?? 0, bestSe ?? 0);
    cloudY = heightOf(bestMean + add);
  }

  const f = view.final;
  const scoreStep = niceStep(domain.hi - domain.lo);
  return {
    probes,
    bead,
    climb,
    bounds: { minX, maxX, minZ, maxZ, maxY },
    mist,
    cloudY,
    selectY: f ? heightOf(f.selectScore) : null,
    testY: f ? heightOf(f.testScore) : null,
    heightOf,
    domain,
    unitsPerScore,
    contour: { scoreStep, step: scoreStep * unitsPerScore, base: heightOf(Math.floor(domain.lo / scoreStep) * scoreStep) },
    bestY: bestMean != null ? heightOf(bestMean) : null,
  };
}

/** A stable key for the probe set that shapes the terrain (rebuild the heightfield only when it changes). */
export function terrainKey(l: SurveyLayout): string {
  let s = "";
  for (const p of l.probes) s += `${p.id}:${p.score01 == null ? "-" : p.pos[1].toFixed(4)}|`;
  return s;
}
