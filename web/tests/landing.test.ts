import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cursorFor, landingFacts } from "@/components/landing/facts";
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
});
