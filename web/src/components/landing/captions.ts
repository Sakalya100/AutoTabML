import type { SurveyPose } from "@/lib/survey/contract";

/** Where each of the climb's three beats starts and ends within the pinned section's progress. */
export const BEAT_AT = [0, 0.34, 0.67, 1];

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Fade in after the window opens, hold, fade out before it closes. */
const windowAlpha = (p: number, a: number, b: number, edge: number) => smooth(a, a + edge, p) * (1 - smooth(b - edge, b, p));

export type CaptionId = "first-probe" | "climb-0" | "climb-1" | "climb-2" | "mist" | "ceiling" | "truth";

/**
 * The single source of truth for captions: given the stage state, which ONE caption is on screen and how opaque.
 * Every caption subscribes and shows itself only if it is the one returned, so two captions can never be visible
 * together. Chapters: fade in after the section becomes active and out before it ends. The pinned climb: three beats
 * in sequence, each fully gone before the next appears.
 */
export function activeCaption(pose: SurveyPose, p: number): { id: CaptionId | null; alpha: number } {
  switch (pose) {
    case "first-probe":
    case "mist":
    case "ceiling":
    case "truth":
      return { id: pose, alpha: windowAlpha(p, 0.1, 0.9, 0.14) };
    case "climb": {
      const i = p < BEAT_AT[1] ? 0 : p < BEAT_AT[2] ? 1 : 2;
      return { id: `climb-${i}` as CaptionId, alpha: windowAlpha(p, BEAT_AT[i] + 0.02, BEAT_AT[i + 1] - 0.02, 0.06) };
    }
    default:
      return { id: null, alpha: 0 };
  }
}


/**
 * The closing map's content is ordinary page flow (it has links), so it would otherwise scroll into view under the
 * locked-test caption. It is held invisible until the chart section is the active one — i.e. after the previous
 * caption has fully faded — then fades in.
 */
export function chartReveal(pose: SurveyPose, p: number): number {
  return pose === "chart" ? smooth(0.03, 0.16, p) : 0;
}
