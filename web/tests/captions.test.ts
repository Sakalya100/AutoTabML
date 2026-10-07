import { describe, expect, it } from "vitest";
import { activeCaption, BEAT_AT, chartReveal } from "@/components/landing/captions";
import type { SurveyPose } from "@/lib/survey/contract";

const POSES: SurveyPose[] = ["orbit", "approach", "first-probe", "climb", "mist", "ceiling", "truth", "chart", "overview"];

describe("landing captions: one at a time, clean hand-offs", () => {
  it("returns at most one caption, with opacity in [0, 1]", () => {
    for (const pose of POSES)
      for (let p = 0; p <= 1.0001; p += 0.01) {
        const a = activeCaption(pose, Math.min(1, p));
        expect(a.alpha).toBeGreaterThanOrEqual(0);
        expect(a.alpha).toBeLessThanOrEqual(1);
        if (a.id === null) expect(a.alpha).toBe(0);
      }
  });

  it("no caption over the hero or the closing map", () => {
    for (const pose of ["orbit", "approach", "chart"] as SurveyPose[]) expect(activeCaption(pose, 0.5).id).toBeNull();
  });

  it("every caption is fully gone at the edges of its window, so the next one never overlaps it", () => {
    for (const pose of ["first-probe", "mist", "ceiling", "truth"] as SurveyPose[]) {
      expect(activeCaption(pose, 0).alpha).toBe(0);
      expect(activeCaption(pose, 1).alpha).toBe(0);
      expect(activeCaption(pose, 0.5).alpha).toBe(1);
    }
    for (let i = 0; i < 3; i++) {
      // just inside each beat boundary the beat is invisible; mid-beat it is fully shown
      expect(activeCaption("climb", BEAT_AT[i] + 0.001).alpha).toBe(0);
      expect(activeCaption("climb", Math.min(1, BEAT_AT[i + 1]) - 0.001).alpha).toBe(0);
      const mid = (BEAT_AT[i] + BEAT_AT[i + 1]) / 2;
      expect(activeCaption("climb", mid)).toEqual({ id: `climb-${i}`, alpha: 1 });
    }
  });
});

describe("closing map content", () => {
  it("stays hidden while any earlier section is active, then fades in", () => {
    for (const pose of ["truth", "ceiling", "climb", "approach"] as SurveyPose[])
      for (let p = 0; p <= 1; p += 0.1) expect(chartReveal(pose, p)).toBe(0);
    expect(chartReveal("chart", 0)).toBe(0);
    expect(chartReveal("chart", 0.3)).toBe(1);
  });
});
