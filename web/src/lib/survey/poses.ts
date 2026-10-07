/**
 * Named camera poses for the survey world (pure: no three.js). Each pose is a function of the layout and a 0..1
 * progress, so a scroll section can scrub a dolly *within* a pose while the rig damps between poses.
 */
import type { SurveyPose } from "./contract";
import type { SurveyLayoutFull } from "./layout";

export interface CameraPose {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);
const smooth01 = (t: number) => ease(Math.min(1, Math.max(0, t)));

/** Climb progress where the follow shot hands over to the summit orbit (the landing's third climb message). */
export const CLIMB_ORBIT_AT = 0.67;

export interface PoseFrame {
  /** Domain-stable framing (complete run for replays). */
  frame: SurveyLayoutFull;
  /** Current playback state (bead, clouds, markers). */
  now: SurveyLayoutFull;
  /** Viewport width / height. */
  aspect: number;
  /**
   * Where the bead is drawn right now, if the caller drives it continuously (landing scroll). The climb pose follows
   * this instead of the stepped best probe, so the camera glides with the rolling bead rather than hopping.
   */
  bead?: [number, number, number] | null;
}

/**
 * A point along the climb path (the kept probes, in order) for a continuous index `t` in [0, n − 1]: t = 1.5 is
 * halfway between the 2nd and 3rd keep. Returns x/z only — the caller puts it on the ground it is drawing.
 */
export function climbPointXZ(climb: readonly (readonly [number, number, number])[], t: number): [number, number] {
  const n = climb.length;
  if (n === 0) return [0, 0];
  const c = Math.min(n - 1, Math.max(0, Number.isFinite(t) ? t : 0));
  const i = Math.min(n - 2, Math.floor(c));
  if (i < 0) return [climb[0][0], climb[0][2]];
  const f = c - i;
  const a = climb[i];
  const b = climb[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Linear blend of two camera poses (w = 0 → a, 1 → b). Both are pure functions of scroll, so the blend is too. */
export function blendPose(a: CameraPose, b: CameraPose, w: number): CameraPose {
  const t = Math.min(1, Math.max(0, w));
  if (t <= 0) return a;
  if (t >= 1) return b;
  return {
    pos: [lerp(a.pos[0], b.pos[0], t), lerp(a.pos[1], b.pos[1], t), lerp(a.pos[2], b.pos[2], t)],
    target: [lerp(a.target[0], b.target[0], t), lerp(a.target[1], b.target[1], t), lerp(a.target[2], b.target[2], t)],
    fov: lerp(a.fov, b.fov, t),
  };
}

export function frameMetrics(l: SurveyLayoutFull) {
  const b = l.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 4);
  return { cx, cz, span, R: span * 0.5 + 3, maxY: b.maxY };
}

/** The summit: the final best probe of the domain run (falls back to the highest probe). */
export function summitOf(l: SurveyLayoutFull): [number, number, number] {
  if (l.bead) return l.bead;
  let best: [number, number, number] | null = null;
  for (const p of l.probes) if (p.score01 != null && (!best || p.pos[1] > best[1])) best = p.pos;
  const m = frameMetrics(l);
  return best ?? [m.cx, l.bounds.maxY, m.cz];
}

export function cameraPose(pose: SurveyPose, progress: number, f: PoseFrame): CameraPose {
  const p = Math.min(1, Math.max(0, progress));
  const e = ease(p);
  const { cx, cz, R, maxY } = frameMetrics(f.frame);
  const summit = summitOf(f.frame);
  // Domain-stable anchors (the full run for replays): reading the stepped playback state here made the camera hop
  // whenever a scrub crossed a step. Only the bead is live, and the landing hands it in continuously.
  const first = f.frame.probes[0]?.pos ?? f.now.probes[0]?.pos ?? [cx, 1, cz];
  const bead = f.bead ?? f.now.bead ?? first;
  let out: CameraPose;
  switch (pose) {
    case "orbit": {
      const a = 0.55 + e * 0.25;
      const d = R * 4.4;
      out = { pos: [cx + Math.sin(a) * d, d * 0.95, cz + Math.cos(a) * d], target: [cx, 0.6, cz], fov: 22 };
      break;
    }
    case "approach": {
      // Hero: the whole survey large in frame, seen from a low three-quarter, drifting slightly with scroll.
      out = {
        pos: [cx + lerp(-2.2, 0.6, e), R * 0.62 + lerp(4.2, 3.4, e), cz + R * 1.55 + lerp(5.2, 4.2, e)],
        target: [cx, lerp(0.9, 1.0, e), cz + R * 0.05],
        fov: 34,
      };
      break;
    }
    case "first-probe": {
      out = {
        pos: [first[0] + lerp(3.4, 2.4, e), first[1] + lerp(1.6, 1.15, e), first[2] + lerp(6.2, 4.6, e)],
        target: [first[0], first[1] + 0.35, first[2]],
        fov: 30,
      };
      break;
    }
    case "climb": {
      // Two moves, so no two consecutive beats are the same kind of shot (landing: messages 3–4, then 5):
      //   1. follow: tracks the bead from a three-quarter, its bearing sweeping as the climb goes on;
      //   2. from CLIMB_ORBIT_AT on: a slow ~40° orbit around the summit with a gentle crane up, while the bead makes
      //      its last roll — ending on the bearing the mist shot starts from, so the next move is a pure descent.
      const yaw = lerp(-0.55, 0.1, ease(Math.min(1, p / CLIMB_ORBIT_AT)));
      const d = 10.5;
      const follow: CameraPose = {
        pos: [bead[0] + Math.sin(yaw) * d, bead[1] + 4.6, bead[2] + Math.cos(yaw) * d],
        target: [lerp(bead[0], cx, 0.35), bead[1] * 0.75, lerp(bead[2], cz, 0.35)],
        fov: 36,
      };
      const w = smooth01((p - (CLIMB_ORBIT_AT - 0.06)) / 0.14);
      if (w <= 0) {
        out = follow;
        break;
      }
      const q = ease(Math.min(1, Math.max(0, (p - CLIMB_ORBIT_AT) / (1 - CLIMB_ORBIT_AT))));
      const az = lerp(0.1, -0.68, q);
      const D = lerp(10.5, 9.6, q);
      const orbit: CameraPose = {
        pos: [summit[0] + Math.sin(az) * D, summit[1] + lerp(4.2, 5.6, q), summit[2] + Math.cos(az) * D],
        target: [lerp(bead[0], summit[0], 0.55), lerp(bead[1] * 0.75, summit[1] * 0.85, q), lerp(bead[2], summit[2], 0.55)],
        fov: lerp(36, 34, q),
      };
      out = blendPose(follow, orbit, w);
      break;
    }
    case "mist": {
      const y = f.frame.bestY ?? f.now.bestY ?? summit[1];
      out = {
        pos: [summit[0] + lerp(-6.5, 4.5, e), y + 0.32, summit[2] + lerp(6.8, 5.2, e)],
        target: [summit[0] + lerp(-0.8, 0.8, e), y - 0.15, summit[2]],
        fov: 32,
      };
      break;
    }
    case "ceiling": {
      const cy = f.frame.cloudY ?? f.now.cloudY ?? summit[1] + 1.2;
      out = {
        pos: [summit[0] + lerp(3.2, 1.2, e), lerp(cy - 1.0, cy + 9, e), summit[2] + lerp(6.5, 3.2, e)],
        target: [summit[0], summit[1] - lerp(0.2, 1.5, e), summit[2]],
        fov: 38,
      };
      break;
    }
    case "truth": {
      const ys = [summit[1], f.frame.selectY ?? f.now.selectY ?? summit[1], f.frame.testY ?? f.now.testY ?? summit[1]];
      const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
      // A tall gauge (a test score far from the others, e.g. housing's RMSE) backs the shot off so the rod and its
      // labels stay in frame. 1 for spreads up to ~3.5 units, so the landing's framing is unchanged.
      const fit = Math.max(1, (Math.max(...ys) - Math.min(...ys) + 0.65) / 4.1);
      out = {
        pos: [summit[0] + lerp(8.5, 6.5, e) * fit, mid + lerp(2.4, 1.6, e) * fit, summit[2] + lerp(9.5, 8.0, e) * fit],
        target: [summit[0] + 0.5, mid, summit[2] + 0.6],
        fov: 32,
      };
      break;
    }
    case "chart": {
      const h = R * 3.3 + 8;
      out = { pos: [cx, h + lerp(4, 0, e), cz + R * 0.18 + 0.6], target: [cx, 0, cz + R * 0.18], fov: 30 };
      break;
    }
    case "overview":
    default: {
      out = { pos: [cx + R * 0.95, maxY + R * 0.9 + 2, cz + R * 1.35], target: [cx, maxY * 0.35, cz], fov: 34 };
      break;
    }
  }
  // Portrait screens: back off along the view direction and widen a little so the subject still fits.
  if (f.aspect < 1) {
    const portrait = 1 - Math.min(1, Math.max(0, (f.aspect - 0.45) / 0.55));
    // (Pages that put copy over the lower half lift the subject with a view offset, see SurveyScrub.shiftY.)
    const wide = pose === "approach" || pose === "orbit" || pose === "overview";
    const k = lerp(1, wide ? 1.95 : 1.5, portrait);
    out = {
      pos: [out.target[0] + (out.pos[0] - out.target[0]) * k, out.target[1] + (out.pos[1] - out.target[1]) * k, out.target[2] + (out.pos[2] - out.target[2]) * k],
      target: out.target,
      fov: out.fov + 6,
    };
  }
  return out;
}
