import { describe, expect, it } from "vitest";
import { BEAT_AT, MESSAGES, messageAt } from "@/components/landing/captions";
import type { SurveyPose } from "@/lib/survey/contract";

const POSES: SurveyPose[] = ["orbit", "approach", "first-probe", "climb", "mist", "ceiling", "truth", "chart", "overview"];
/** Page order, top → bottom. */
const PAGE: SurveyPose[] = ["approach", "first-probe", "climb", "mist", "ceiling", "truth", "chart"];

describe("landing copy rail: exactly one message everywhere", () => {
  it("is total: every pose and progress (including out-of-range input) has a message", () => {
    for (const pose of POSES)
      for (let p = -0.2; p <= 1.2001; p += 0.01) {
        const id = messageAt(pose, p);
        expect(MESSAGES).toContain(id);
      }
    expect(MESSAGES).toContain(messageAt("climb", Number.NaN));
  });

  it("is monotonic down the page and visits every message in order", () => {
    let prev = -1;
    const seen: string[] = [];
    for (const pose of PAGE)
      for (let p = 0; p <= 1.0001; p += 0.005) {
        const id = messageAt(pose, Math.min(1, p));
        const i = MESSAGES.indexOf(id);
        expect(i).toBeGreaterThanOrEqual(prev);
        prev = i;
        if (seen.at(-1) !== id) seen.push(id);
      }
    expect(seen).toEqual([...MESSAGES]);
  });

  it("starts on the hero and ends on the map", () => {
    expect(messageAt("orbit", 0)).toBe("hero");
    expect(messageAt("approach", 0)).toBe("hero");
    expect(messageAt("chart", 1)).toBe("map");
  });

  it("splits the climb into three beats at BEAT_AT", () => {
    for (let i = 0; i < 3; i++) {
      const mid = (BEAT_AT[i] + BEAT_AT[i + 1]) / 2;
      expect(messageAt("climb", mid)).toBe(`climb-${i}`);
    }
  });
});
