import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { beadTFor, climbCoord, cursorFor, landingFacts } from "@/components/landing/facts";
import { layoutSurvey } from "@/lib/survey/layout";
import { climbPointXZ } from "@/lib/survey/poses";
import { parseEventsJsonl } from "@/lib/events";
import { buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";

const dir = path.join(__dirname, "..", "public", "replays", "breast_cancer");
const events = parseEventsJsonl(readFileSync(path.join(dir, "events.jsonl"), "utf8"));
const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
const facts = landingFacts("breast_cancer", "breast cancer", events, record);

describe("landing facts (real breast_cancer replay)", () => {
  it("counts match the run", () => {
    expect(facts.nExperiments).toBe(37);
    expect(facts.nKept).toBe(4);
    expect(facts.nKept + facts.nDiscarded + facts.nCrashed).toBe(37);
    expect(facts.nRows).toBe(569);
    expect(facts.proposer).toBe("heuristic");
  });

  it("the growth sequence runs from an empty seabed, one experiment per step, to the stop", () => {
    const g = facts.growth;
    expect(g).toHaveLength(1 + 37 + 1);
    expect(g[0]).toMatchObject({ n: 0, kept: 0, best: null });
    for (let i = 1; i < g.length; i++) expect(g[i].cursor).toBeGreaterThan(g[i - 1].cursor);
    expect(g.at(-1)).toMatchObject({ n: 37, kept: 4 });
    expect(buildView(events.slice(0, g.at(-1)!.cursor)).phase).toBe("stopped");
    expect(buildView(events.slice(0, g[1].cursor)).experiments).toHaveLength(1);
    expect(facts.end).toBe(events.length);
    expect(buildView(events.slice(0, facts.end)).phase).toBe("finished");
  });

  it("the live best score is the run's own best", () => {
    const best = facts.growth.map((s) => s.best).filter((b): b is number => b != null);
    expect(best).toHaveLength(38); // 37 decisions + the stop
    const finalBest = record.experiments?.find((e) => e.id === record.best_exp_id)?.cv as { mean?: number } | undefined;
    expect(best.at(-1)).toBeCloseTo(finalBest?.mean ?? NaN, 10);
  });

  it("stop and locked-test numbers come from the stop report and final scores", () => {
    expect(facts.stop?.reason).toBe("ceiling");
    expect(facts.stop?.signals).toBeGreaterThan(0);
    expect(facts.stop?.fired).toBe(facts.stop?.signals);
    expect(facts.final?.test).toBeCloseTo(0.99363, 4);
    expect(facts.final?.gapText).toMatch(/no optimism/);
  });

  it("survey numbers: baseline, mist (best SE) and the fitted ceiling come from the replay", () => {
    expect(facts.survey.baseline).toBeCloseTo(0.9921945578231293, 12);
    expect(facts.survey.best).toBeCloseTo(0.9979319727891156, 12);
    expect(facts.survey.bestSe).toBeCloseTo(0.0009291298479550506, 12);
    expect(facts.survey.ceiling).toBeCloseTo(0.9979319727891156 + 0.0008808720433843842, 12);
  });
});

describe("landing scroll → replay moment", () => {
  it("never rewinds while scrolling down the page (the bead never vanishes and reappears)", () => {
    const order = ["orbit", "approach", "first-probe", "climb", "mist", "ceiling", "truth", "chart"] as const;
    let prev = -1;
    for (const pose of order) {
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const { cursor } = cursorFor(pose, Math.min(1, p), facts, false);
        expect(cursor).toBeGreaterThanOrEqual(prev);
        prev = cursor;
      }
    }
    expect(prev).toBe(facts.end);
  });

  it("the bead is on the land from the very first screen", () => {
    const { cursor } = cursorFor("approach", 0, facts, false);
    expect(buildView(events.slice(0, cursor)).experiments.length).toBeGreaterThanOrEqual(1);
  });

  it("the bead's place along the climb is monotonic down the page and ends on the final best", () => {
    const order = ["orbit", "approach", "first-probe", "climb", "mist", "ceiling", "truth", "chart"] as const;
    let prev = -1;
    for (const pose of order)
      for (let p = 0; p <= 1.0001; p += 0.002) {
        const t = beadTFor(pose, Math.min(1, p), facts, false);
        expect(t).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = t;
      }
    expect(beadTFor("approach", 0, facts, false)).toBe(0);
    expect(prev).toBe(facts.nKept - 1);
  });

  it("the bead rolls continuously (no jumps) through the climb, and rests on the best between keeps", () => {
    let prev = beadTFor("climb", 0, facts, false);
    for (let p = 0.0005; p <= 1.0001; p += 0.0005) {
      const t = beadTFor("climb", Math.min(1, p), facts, false);
      expect(Math.abs(t - prev)).toBeLessThan(0.05);
      prev = t;
    }
    const full = buildView(events);
    const L = layoutSurvey(full, full);
    // wherever the bead rests it sits on a best probe: before a new keep's roll it is the previous best (the keep has
    // landed but the bead has not moved yet), after it the new one
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const t = beadTFor("climb", Math.min(1, p), facts, false);
      if (Math.abs(t - Math.round(t)) > 1e-9) continue;
      const c = climbCoord(Math.min(1, p), facts);
      const [x, z] = climbPointXZ(L.climb, t);
      const at = (i: number) => layoutSurvey(buildView(events.slice(0, facts.growth[Math.min(i, facts.growth.length - 1)].cursor)), full).bead!;
      const ok = [at(Math.floor(c)), at(Math.ceil(c))].some((b) => Math.abs(b[0] - x) < 1e-9 && Math.abs(b[2] - z) < 1e-9);
      expect(ok).toBe(true);
    }
  });

  it("an experiment lands before the bead rolls to it (the climb coordinate leads the cursor)", () => {
    for (let p = 0; p <= 1.0001; p += 0.003) {
      const c = climbCoord(Math.min(1, p), facts);
      const { step } = cursorFor("climb", Math.min(1, p), facts, false);
      expect(step).toBeGreaterThanOrEqual(Math.floor(c));
      const t = beadTFor("climb", Math.min(1, p), facts, false);
      expect(Math.ceil(t - 1e-9)).toBeLessThanOrEqual(Math.max(0, facts.growth[step].kept - 1));
    }
  });
});
