/**
 * Fine structure of one experiment's branch: deterministic fractal twigs and leaf/polyp counts. Pure (no three.js),
 * unit-tested with the layout.
 *
 * The twigs are decoration OF a real experiment branch — never extra experiments. How many there are and how far
 * they reach comes from that experiment's own data (its `vigour`: score within the run for kept branches, closeness
 * to the parent for discards). Crashes and still-running experiments carry none.
 *
 * Specs are relative (a position along the parent curve, angles around its tangent, a length fraction), so the scene
 * can resolve them against the branch's *current* (tweened) curve every frame and the twigs stay attached.
 */
import type { ReefNode } from "./contract";
import { hash01 } from "./layout";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export interface TwigSpec {
  /** -1 = the experiment's own branch; otherwise the index of the parent twig in the same list (always earlier). */
  parent: number;
  level: 1 | 2 | 3;
  /** Attach point along the parent curve, 0..1. */
  t: number;
  /** Phyllotaxis angle around the parent's tangent (radians). */
  azimuth: number;
  /** Divergence from the parent's tangent (radians). */
  elev: number;
  /** Length as a fraction of the parent's length. */
  len: number;
  /** Base radius as a fraction of the parent's radius at the attach point. */
  r: number;
  /** Leaves / polyps budding at this twig's end (0 for twigs that carry further twigs, and for discards' bare twigs once withered). */
  leaves: number;
}

/** Twigs for one node. `lite` halves the recursion for thumbnails / phones. */
export function twigSpecs(node: Pick<ReefNode, "id" | "status" | "vigour" | "score01">, lite = false): TwigSpec[] {
  if (node.status === "crash" || node.status === "running") return [];
  const kept = node.status === "keep";
  const v = clamp01(node.vigour ?? node.score01 ?? 0.5);
  const h = hash01(node.id);
  const rnd = mulberry(Math.floor(h * 2 ** 31) ^ 0x9e3779b9);
  const out: TwigSpec[] = [];

  // Level 1 along the experiment's own branch, spaced up its upper two-thirds in golden-angle phyllotaxis.
  const n1 = kept ? 2 + Math.round(2 * v) - (lite ? 1 : 0) : 1 + Math.round(2 * v) - (lite && v > 0.5 ? 1 : 0);
  const n2 = kept ? (lite ? 1 : 2) : v > 0.55 && !lite ? 2 : 1;
  const deep = kept && !lite; // a third level on kept branches at full quality
  for (let i = 0; i < n1; i++) {
    const t = 0.38 + 0.52 * ((i + 0.5 + (rnd() - 0.5) * 0.5) / n1);
    const a1 = h * Math.PI * 2 + i * GOLDEN + (rnd() - 0.5) * 0.4;
    const i1 = out.length;
    out.push({
      parent: -1,
      level: 1,
      t,
      azimuth: a1,
      elev: (32 + 22 * rnd()) * (Math.PI / 180),
      // Lower twigs are longer (a conical crown); vigour stretches all of them.
      len: (0.3 + 0.16 * v) * (1.15 - 0.45 * t) * (kept ? 1 : 0.85),
      r: 0.5 + 0.12 * rnd(),
      leaves: 0,
    });
    for (let j = 0; j < n2; j++) {
      const t2 = 0.45 + 0.45 * ((j + 0.5) / n2) + (rnd() - 0.5) * 0.08;
      const i2 = out.length;
      out.push({
        parent: i1,
        level: 2,
        t: t2,
        azimuth: a1 + (j % 2 ? 1 : -1) * (1.1 + 0.6 * rnd()) + j * GOLDEN,
        elev: (30 + 20 * rnd()) * (Math.PI / 180),
        len: 0.5 + 0.16 * rnd(),
        r: 0.6,
        leaves: 0,
      });
      if (deep) {
        out.push({
          parent: i2,
          level: 3,
          t: 0.6 + 0.25 * rnd(),
          azimuth: rnd() * Math.PI * 2,
          elev: (28 + 18 * rnd()) * (Math.PI / 180),
          len: 0.5 + 0.15 * rnd(),
          r: 0.62,
          leaves: 0,
        });
      }
    }
  }

  // Leaves bud on the terminal twigs (and at the branch's own tip). Discards bud too — then shed them as they wither.
  const hasChild = new Set(out.map((s) => s.parent));
  for (let i = 0; i < out.length; i++) {
    if (hasChild.has(i)) continue;
    out[i].leaves = kept ? 3 + Math.round(2 * v) - (lite ? 1 : 0) : 2;
  }
  return out;
}

/** Leaves at the experiment's own tip (kept: a crown cluster; discard: a couple that will fall). */
export function tipLeaves(node: Pick<ReefNode, "status" | "vigour">, lite = false): number {
  if (node.status === "keep") return (lite ? 3 : 5) + Math.round(2 * clamp01(node.vigour ?? 0.5));
  if (node.status === "discard") return 2;
  return 0;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
