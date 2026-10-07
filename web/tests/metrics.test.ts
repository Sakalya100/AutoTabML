import { describe, expect, it } from "vitest";
import { describeGap, directionLabel, fmtNum, formatScore, greaterIsBetter, scoreDelta, toOriented, toRaw } from "@/lib/metrics";

describe("orientation", () => {
  it("knows which metrics are minimised (matches contracts.Metric)", () => {
    for (const m of ["log_loss", "rmse", "mae"]) expect(greaterIsBetter(m)).toBe(false);
    for (const m of ["roc_auc", "accuracy", "f1_macro", "r2"]) expect(greaterIsBetter(m)).toBe(true);
  });
  it("round-trips raw ↔ oriented", () => {
    expect(toRaw("log_loss", -0.0812)).toBeCloseTo(0.0812);
    expect(toOriented("rmse", 3.2)).toBeCloseTo(-3.2);
    expect(toRaw("accuracy", 0.95)).toBe(0.95);
    expect(Object.is(toRaw("mae", 0), 0)).toBe(true); // no "-0"
  });
  it("labels direction", () => {
    expect(directionLabel("log_loss")).toMatch(/lower/);
    expect(directionLabel("roc_auc")).toMatch(/higher/);
  });
});

describe("formatting", () => {
  it("formats oriented scores as raw values", () => {
    expect(formatScore("log_loss", -0.07412)).toBe("0.0741");
    expect(formatScore("r2", 0.81234, 2)).toBe("0.81");
    expect(formatScore("rmse", null)).toBe("—");
  });
  it("expresses deltas in raw units with improvement flag", () => {
    const d = scoreDelta("log_loss", -0.0812, -0.0743)!;
    expect(d.better).toBe(true);
    expect(d.raw).toBeCloseTo(-0.0069);
    expect(d.text).toBe("−0.0069");
    const up = scoreDelta("accuracy", 0.9, 0.92)!;
    expect(up.better).toBe(true);
    expect(up.text).toBe("+0.0200");
    expect(scoreDelta("accuracy", null, 0.9)).toBeNull();
  });
  it("describes the optimism gap unambiguously for both directions", () => {
    expect(describeGap("log_loss", 0.0151)).toMatch(/higher than select — select was optimistic/);
    expect(describeGap("roc_auc", 0.02)).toMatch(/lower than select — select was optimistic/);
    expect(describeGap("roc_auc", -0.01)).toMatch(/no optimism/);
  });
});

import { niceTicks } from "@/lib/chart";
describe("niceTicks", () => {
  it("produces 4–8 round ticks inside the domain", () => {
    const t = niceTicks(-0.16, -0.06, 6);
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t.length).toBeLessThanOrEqual(8);
    expect(t.every((v) => v >= -0.16 && v <= -0.06)).toBe(true);
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe("fmtNum", () => {
  it("keeps small values fixed and compacts large ones", () => {
    expect(fmtNum(0.123456)).toBe("0.1235");
    expect(fmtNum(1195595.2576)).toBe("1.196M");
    expect(fmtNum(62318.43)).toBe("62.32K");
  });
});
