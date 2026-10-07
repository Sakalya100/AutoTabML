/**
 * The replay page's scroll journey, for ANY finished run: the landing's model (prebuilt land; scroll moves only the
 * ball, the camera and the section moments; one message at every scroll position) generalised from one hand-paced
 * story to every recorded run. Pure (no React, no three.js) and unit-tested for all replays in tests/journey.test.ts.
 *
 * The climb section walks EVERY idea in order, and is laid out as an invertible span table:
 *   - the roll: ideas 0 … lastKeep−1. The ball rolls from keep to keep at a constant pace within each leg (the landing's
 *     `paced` ease only at the very start and end); the ideas tried on a leg share it equally, and keep j+1's card
 *     appears exactly when the ball arrives on it (the kept count increments on arrival, never before);
 *   - the tail: the last keep, then every idea after it. The ball rests on the summit while the camera turns around
 *     it and leans toward each dropped marker in turn (aimId), so a long run of misses never stalls the shot.
 */
import type { RunView } from "@/lib/run-state";
import type { SurveyPose } from "@/lib/survey/contract";
import { CLIMB_ORBIT_AT } from "@/lib/survey/poses";
import { climbLengthsOf, paced } from "@/components/landing/facts";

/**
 * Scroll budget (svh). Before the last keep every idea gets its own card and at least MIN_IDEA_VH of scroll (≈ 1.5
 * mouse-wheel ticks on a laptop screen), so it can be read. The last keep's card gets KEEP_VH. The tail — every idea
 * after the last keep — is ONE message whose ticker line steps through the misses; it gets about two beats in total.
 */
export const IDEA_VH = 36;
export const MIN_IDEA_VH = 32;
export const KEEP_VH = 44;
const TAIL_IDEA_VH = 16;
const TAIL_MIN_VH = 150;
const TAIL_MAX_VH = 300;
/** Where the follow shot hands over to the summit orbit, in the climb pose's own progress. */
const ORBIT_FROM = CLIMB_ORBIT_AT - 0.06;

export interface Journey {
  n: number;
  /** Indices of the kept ideas, ascending (keeps[0] is the baseline when it was kept). */
  keeps: number[];
  lastKeep: number;
  /** Climb progress where the roll ends (the last keep's card begins; 0 when only one idea was kept). */
  rollEnd: number;
  /** Climb progress where the tail (the ideas after the last keep) begins (1 when there are none). */
  tailFrom: number;
  /** Number of ideas after the last keep. */
  tailN: number;
  /** Cumulative share of the roll at the start of each leg (length legs + 1, last = 1). */
  legAt: number[];
  /** Start of each idea's slice in climb progress (length n + 1; starts[n] = 1). */
  starts: number[];
  climbVh: number;
}

/** The sections of the journey, top to bottom. `kind` names the message; `pose` the camera. */
export type BeatKind = "summary" | "climb" | "noise" | "stop" | "test" | "map" | "record";
export interface Beat {
  kind: BeatKind;
  pose: SurveyPose;
  vh: number;
}

export function journeyOf(view: RunView): Journey {
  const exps = view.experiments;
  const n = exps.length;
  const keeps = exps.filter((x) => x.status === "keep").map((x) => x.index);
  const lastKeep = keeps.length ? keeps[keeps.length - 1] : 0;
  const L = keeps.length > 1 ? climbLengthsOf(view).slice(0, keeps.length - 1) : [];
  const legs = Math.max(0, keeps.length - 1);
  // Each leg's share of the roll: half by map length (a constant pace along the map), half by the ideas tried on it
  // (so a short leg crowded with ideas still gives each one room to be read). Constant pace within a leg.
  const totalL = L.reduce((a, b) => a + b, 0);
  const totalG = legs ? keeps[legs] - keeps[0] : 0;
  const share: number[] = [];
  for (let j = 0; j < legs; j++) {
    const g = (keeps[j + 1] - keeps[j]) / Math.max(1, totalG);
    share.push(totalL > 0 ? 0.5 * (L[j] / totalL) + 0.5 * g : g);
  }
  const legAt = [0];
  for (const s of share) legAt.push(legAt[legAt.length - 1] + s);
  if (legs) legAt[legs] = 1;

  const tailN = Math.max(0, n - 1 - lastKeep);
  const J: Journey = { n, keeps, lastKeep, rollEnd: 0, tailFrom: 1, tailN, legAt, starts: [], climbVh: 0 };
  // Where each roll idea starts, as a fraction of the roll: the same leg arithmetic `climbAt` uses, inverted through
  // the ease, so the card and the ball can never disagree.
  const r: number[] = [];
  for (let i = 0; i < lastKeep; i++) {
    if (!legs || i <= keeps[0]) {
      r.push(0);
      continue;
    }
    const j = Math.max(0, legOfIdea(J, i));
    const g = keeps[j + 1] - keeps[j];
    const q = legAt[j] + (legAt[j + 1] - legAt[j]) * (Math.max(0, i - keeps[j]) / g);
    r.push(pacedInv(q));
  }
  r.push(1);
  let minSlice = 1;
  for (let i = keeps[0] ?? 0; i < lastKeep; i++) minSlice = Math.min(minSlice, r[i + 1] - r[i]);
  const rollVh = legs ? Math.max(IDEA_VH * lastKeep, MIN_IDEA_VH / Math.max(1e-3, minSlice)) : 0;
  const keepVh = n ? KEEP_VH : 0;
  const tailVh = tailN ? Math.min(TAIL_MAX_VH, Math.max(TAIL_MIN_VH, TAIL_IDEA_VH * tailN)) : 0;
  const total = rollVh + keepVh + tailVh;
  J.climbVh = Math.round(total);
  J.rollEnd = total > 0 ? rollVh / total : 0;
  J.tailFrom = total > 0 && tailN ? (rollVh + keepVh) / total : 1;

  const starts: number[] = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    if (i < lastKeep) starts[i] = J.rollEnd * r[i];
    else if (i === lastKeep) starts[i] = J.rollEnd;
    else starts[i] = J.tailFrom + ((i - lastKeep - 1) / tailN) * (1 - J.tailFrom);
  }
  starts[n] = 1;
  J.starts = starts;
  return J;
}

function legOfIdea(J: Journey, i: number): number {
  let j = 0;
  while (j + 1 < J.keeps.length - 1 && J.keeps[j + 1] <= i) j++;
  return j;
}

/** Inverse of the landing's `paced` (monotonic), by bisection. */
function pacedInv(q: number): number {
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 48; k++) {
    const mid = (lo + hi) / 2;
    if (paced(mid) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

/** Where the climb is at progress p: the idea on the card, the ball's place on the climb path, the camera aim. */
export interface ClimbAt {
  idea: number;
  /** Index along the kept probes (fractional while rolling). */
  beadT: number;
  /** 0..1 within the current idea's slice. */
  f: number;
  /** The climb pose's own progress (roll → follow shot, tail → summit orbit). */
  poseP: number;
  /** Lean toward the current dropped idea's marker (tail only), 0 at slice edges so it never snaps. */
  aimW: number;
}

export function climbAt(J: Journey, p: number, reduced = false): ClimbAt {
  const x = clamp01(p);
  const m = Math.max(0, J.keeps.length - 1);
  if (J.n === 0) return { idea: 0, beadT: 0, f: 0, poseP: 0, aimW: 0 };
  if (x < J.rollEnd && m > 0) {
    const q = paced(x / J.rollEnd);
    let j = 0;
    while (j + 1 < m && J.legAt[j + 1] <= q) j++;
    const span = Math.max(1e-12, J.legAt[j + 1] - J.legAt[j]);
    const f = Math.min(1, Math.max(0, (q - J.legAt[j]) / span));
    const g = J.keeps[j + 1] - J.keeps[j];
    const r = Math.min(g - 1, Math.floor(f * g + 1e-9));
    const idea = J.keeps[j] + r;
    const beadT = reduced ? j : j + f;
    const s0 = J.starts[idea];
    const s1 = J.starts[idea + 1];
    return { idea, beadT, f: s1 > s0 ? clamp01((x - s0) / (s1 - s0)) : 0, poseP: ORBIT_FROM * (x / J.rollEnd), aimW: 0 };
  }
  // the tail: binary search over the slice starts
  let lo = J.lastKeep;
  let hi = J.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (J.starts[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  const idea = lo;
  const s0 = J.starts[idea];
  const s1 = J.starts[idea + 1];
  const f = s1 > s0 ? clamp01((x - s0) / (s1 - s0)) : 0;
  const u = J.rollEnd < 1 ? (x - J.rollEnd) / (1 - J.rollEnd) : 1;
  const aimW = idea <= J.lastKeep ? 0 : Math.sin(Math.PI * f) ** 0.8;
  return { idea, beadT: m, f, poseP: ORBIT_FROM + (1 - ORBIT_FROM) * clamp01(u), aimW };
}

/** Climb progress at the middle of idea i's slice (bar clicks and ←/→ land here). */
export function progressForIdea(J: Journey, i: number): number {
  const k = Math.min(J.n - 1, Math.max(0, Math.round(i)));
  return (J.starts[k] + J.starts[k + 1]) / 2;
}

/** Number of kept ideas among 0 … i (what the card's "kept so far" says). */
export function keptThrough(J: Journey, i: number): number {
  return J.keeps.filter((k) => k <= i).length;
}

/* ---- the copy rail: one message at every scroll position ---- */

export type JourneyMsg = "summary" | `idea-${number}` | "tail" | "noise" | "stop" | "test" | "map" | "record";

/** The beats a run has: a run that never stopped or was never tested skips those moments. */
export function beatsOf(J: Journey, has: { stop: boolean; final: boolean }): Beat[] {
  const out: Beat[] = [
    { kind: "summary", pose: "approach", vh: 100 },
    { kind: "climb", pose: "climb", vh: J.climbVh },
  ];
  if (has.stop) out.push({ kind: "noise", pose: "mist", vh: 120 }, { kind: "stop", pose: "ceiling", vh: 130 });
  if (has.final) out.push({ kind: "test", pose: "truth", vh: 130 });
  out.push({ kind: "map", pose: "chart", vh: 130 }, { kind: "record", pose: "chart", vh: 0 });
  return out;
}

/** Every message in page order. */
export function messagesOf(J: Journey, beats: readonly Beat[]): JourneyMsg[] {
  const out: JourneyMsg[] = [];
  for (const b of beats) {
    if (b.kind === "climb") {
      for (let i = 0; i <= Math.min(J.lastKeep, J.n - 1); i++) out.push(`idea-${i}`);
      if (J.tailN) out.push("tail");
    }
    else out.push(b.kind);
  }
  return out;
}

/** Total and monotonic: exactly one message for every (beat, progress), including out-of-range input. */
export function messageAt(J: Journey, kind: BeatKind, p: number): JourneyMsg {
  if (kind === "climb") {
    if (J.n === 0) return "summary";
    const i = climbAt(J, p).idea;
    // the ideas after the last keep share one message (its ticker line steps through them)
    return i > J.lastKeep ? "tail" : `idea-${i}`;
  }
  return kind;
}

/** The camera's progress within a beat's pose. */
export function poseProgress(J: Journey, kind: BeatKind, p: number): number {
  if (kind === "climb") return climbAt(J, p).poseP;
  if (kind === "record") return 1;
  return clamp01(p);
}

/** The ball's place along the climb for a beat and its progress: the baseline before the climb, the summit after. */
export function beadTAt(J: Journey, kind: BeatKind, p: number, reduced = false): number {
  if (kind === "summary") return 0;
  if (kind === "climb") return climbAt(J, p, reduced).beadT;
  return Math.max(0, J.keeps.length - 1);
}
