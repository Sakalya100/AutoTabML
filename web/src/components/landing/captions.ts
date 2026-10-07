import type { SurveyPose } from "@/lib/survey/contract";

/** Where each of the climb's three beats starts and ends within the climb section's progress. */
export const BEAT_AT = [0, 0.34, 0.67, 1];

/** Every message the landing's copy rail can show, in page order (top → bottom). */
export const MESSAGES = ["hero", "first", "climb-0", "climb-1", "climb-2", "mist", "ceiling", "test", "map"] as const;
export type MessageId = (typeof MESSAGES)[number];

/**
 * The single source of truth for the copy rail: exactly ONE message for every scroll position, top to bottom.
 * Total (never null, no fades to nothing) and monotonic down the page, so the rail can only ever swap one message for
 * the next — two can never be on screen, and there is never a frame with none.
 */
export function messageAt(pose: SurveyPose, p: number): MessageId {
  switch (pose) {
    case "orbit":
    case "approach":
      return "hero";
    case "first-probe":
      return "first";
    case "climb": {
      const x = Number.isFinite(p) ? p : 0;
      return x < BEAT_AT[1] ? "climb-0" : x < BEAT_AT[2] ? "climb-1" : "climb-2";
    }
    case "mist":
      return "mist";
    case "ceiling":
      return "ceiling";
    case "truth":
      return "test";
    case "chart":
    case "overview":
    default:
      return "map";
  }
}
