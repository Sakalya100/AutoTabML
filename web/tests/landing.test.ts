import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BEAT_AT } from "@/components/landing/captions";
import { beadTFor, cursorFor, landingFacts } from "@/components/landing/facts";
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

  const full = buildView(events);
  const L = layoutSurvey(full, full);
  /** World (x/z) position of the bead for a climb progress. */
  const beadXZ = (p: number) => climbPointXZ(L.climb, beadTFor("climb", p, facts, false));

  it("the bead rolls through every keep during the climb, at a calm, near-constant speed (no rush, no dead stretch)", () => {
    expect(beadTFor("climb", 0, facts, false)).toBe(0);
    expect(beadTFor("climb", 1, facts, false)).toBe(facts.nKept - 1);
    const dp = 0.0025;
    const speeds: number[] = [];
    // distance travelled along the path (map units), from the bead's place on it
    const arc = (p: number) => {
      const t = beadTFor("climb", p, facts, false);
      let d = 0;
      for (let i = 0; i + 1 < L.climb.length; i++) {
        const seg = Math.hypot(L.climb[i + 1][0] - L.climb[i][0], L.climb[i + 1][2] - L.climb[i][2]);
        d += seg * Math.min(1, Math.max(0, t - i));
      }
      return d;
    };
    for (let p = 0.04; p <= 0.96 + 1e-9; p += dp) speeds.push((arc(p + dp) - arc(p)) / dp);
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    expect(Math.max(...speeds)).toBeLessThanOrEqual(2 * mean);
    // only the very start and end ease (the first / last ~7% of the roll); in between it cruises
    const cruise = speeds.slice(Math.ceil(0.07 / dp), speeds.length - Math.ceil(0.07 / dp));
    expect(Math.min(...cruise)).toBeGreaterThan(0.85 * mean);
  });

  it("the bead moves during each of the climb's three messages", () => {
    for (let i = 0; i < 3; i++) {
      const [x0, z0] = beadXZ(BEAT_AT[i] + 0.02);
      const [x1, z1] = beadXZ(BEAT_AT[i + 1] - 0.02);
      expect(Math.hypot(x1 - x0, z1 - z0)).toBeGreaterThan(1);
    }
  });

  it("the rail's kept count is the number of keeps the bead has reached", () => {
    for (let p = 0; p <= 1.0001; p += 0.001) {
      const t = beadTFor("climb", Math.min(1, p), facts, false);
      const { step } = cursorFor("climb", Math.min(1, p), facts, false);
      expect(facts.growth[step].kept).toBe(Math.floor(t + 1e-9) + 1);
    }
  });

  it("the experiments after the last keep are counted through during the mist, then the stop", () => {
    const lastKeep = facts.growth.findIndex((g) => g.kept === facts.nKept);
    expect(cursorFor("climb", 1, facts, false).step).toBe(lastKeep);
    expect(cursorFor("mist", 0, facts, false).step).toBe(lastKeep);
    expect(cursorFor("mist", 1, facts, false).step).toBe(facts.growth.length - 2);
    expect(facts.growth[cursorFor("mist", 1, facts, false).step].n).toBe(facts.nExperiments);
    expect(cursorFor("ceiling", 0, facts, false).step).toBe(facts.growth.length - 1);
  });
});
