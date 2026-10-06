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

export interface PoseFrame {
  /** Domain-stable framing (complete run for replays). */
  frame: SurveyLayoutFull;
  /** Current playback state (bead, clouds, markers). */
  now: SurveyLayoutFull;
  /** Viewport width / height. */
  aspect: number;
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
  const first = f.now.probes[0]?.pos ?? f.frame.probes[0]?.pos ?? [cx, 1, cz];
  const bead = f.now.bead ?? first;
  let out: CameraPose;
  switch (pose) {
    case "orbit": {
      const a = 0.55 + e * 0.25;
      const d = R * 4.4;
      out = { pos: [cx + Math.sin(a) * d, d * 0.95, cz + Math.cos(a) * d], target: [cx, 0.6, cz], fov: 22 };
      break;
    }
    case "approach": {
      out = {
        pos: [cx + lerp(-1.2, 1.2, e), R * 1.05 + lerp(5.5, 3.5, e), cz + R * 2.45 + lerp(10, 7, e)],
        target: [cx, lerp(0.2, 0.6, e), cz + R * 0.5],
        fov: 32,
      };
      break;
    }
    case "first-probe": {
      out = {
        pos: [first[0] + lerp(2.6, 1.7, e), first[1] + lerp(1.15, 0.75, e), first[2] + lerp(4.8, 3.3, e)],
        target: [first[0], first[1] + 0.35, first[2]],
        fov: 30,
      };
      break;
    }
    case "climb": {
      const yaw = lerp(-0.55, 0.45, e);
      const d = 10.5;
      out = {
        pos: [bead[0] + Math.sin(yaw) * d, bead[1] + 4.6, bead[2] + Math.cos(yaw) * d],
        target: [lerp(bead[0], cx, 0.35), bead[1] * 0.75, lerp(bead[2], cz, 0.35)],
        fov: 36,
      };
      break;
    }
    case "mist": {
      const y = f.now.bestY ?? summit[1];
      out = {
        pos: [summit[0] + lerp(-6.5, 4.5, e), y + 0.32, summit[2] + lerp(6.8, 5.2, e)],
        target: [summit[0] + lerp(-0.8, 0.8, e), y - 0.15, summit[2]],
        fov: 32,
      };
      break;
    }
    case "ceiling": {
      const cy = f.now.cloudY ?? summit[1] + 1.2;
      out = {
        pos: [summit[0] + lerp(3.2, 1.2, e), lerp(cy - 1.0, cy + 9, e), summit[2] + lerp(6.5, 3.2, e)],
        target: [summit[0], summit[1] - lerp(0.2, 1.5, e), summit[2]],
        fov: 38,
      };
      break;
    }
    case "truth": {
      const ys = [summit[1], f.now.selectY ?? summit[1], f.now.testY ?? summit[1]];
      const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
      out = {
        pos: [summit[0] + lerp(8.5, 6.5, e), mid + lerp(2.4, 1.6, e), summit[2] + lerp(9.5, 8.0, e)],
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
    // The outro map climbs above the captions that fill the lower half of a phone.
    if (pose === "chart") {
      const dz = R * 0.75 * portrait;
      out = { ...out, pos: [out.pos[0], out.pos[1], out.pos[2] + dz], target: [out.target[0], out.target[1], out.target[2] + dz] };
    }
    const wide = pose === "approach" || pose === "orbit" || pose === "chart" || pose === "overview";
    const k = lerp(1, wide ? 1.95 : 1.5, portrait);
    out = {
      pos: [out.target[0] + (out.pos[0] - out.target[0]) * k, out.target[1] + (out.pos[1] - out.target[1]) * k, out.target[2] + (out.pos[2] - out.target[2]) * k],
      target: out.target,
      fov: out.fov + 6,
    };
  }
  return out;
}
