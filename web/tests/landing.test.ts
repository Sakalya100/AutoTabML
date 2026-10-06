import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { landingFacts } from "@/components/landing/facts";
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
    expect(facts.profile?.nRows).toBe(569);
    expect(facts.profile?.sampleRows).toBeLessThanOrEqual(5);
  });

  it("showcases the winning mutation with its real diff", () => {
    expect(facts.showcase?.id).toBe(record.best_exp_id);
    expect(facts.showcase?.diff.some((d) => d.t === "+")).toBe(true);
    expect(facts.keepPair?.decision).toBe("keep");
    expect(facts.keepPair?.p).toBeLessThan(facts.gate.alpha ?? 0.1);
  });

  it("the withered example scored higher than its parent yet failed the gate", () => {
    const d = facts.discardPair!;
    expect(d.decision).toBe("discard");
    expect(d.exp.mean).toBeGreaterThan(d.parent.mean);
    expect(d.p).toBeGreaterThanOrEqual(facts.gate.alpha ?? 0.1);
    expect(d.exp.folds).toHaveLength(d.parent.folds.length);
  });

  it("chapter cursors put the reef in the state each chapter describes", () => {
    const at = (c: number | null) => buildView(events.slice(0, c ?? events.length));
    expect(facts.cursors.intro).toBeNull();
    expect(at(facts.cursors.nutrients).profile).not.toBeNull();
    expect(at(facts.cursors.nutrients).experiments).toHaveLength(0);
    expect(at(facts.cursors.mutation).current?.id).toBe(facts.showcase?.id);
    expect(at(facts.cursors.selection).phase).toBe("running");
    expect(at(facts.cursors.ceiling).phase).toBe("stopped");
    expect(at(facts.cursors.test).phase).toBe("finished");
  });

  it("ceiling and pearl numbers come from the stop report and final scores", () => {
    expect(facts.stop?.saturationParams).toHaveLength(3);
    expect(facts.stop?.trajectory).toHaveLength(37);
    expect(facts.stop?.signals.map((s) => s.key)).toEqual(["noise_floor", "saturation", "exploration", "external_ref"]);
    expect(facts.final?.test).toBeCloseTo(0.99363, 4);
    expect(facts.final?.gapText).toMatch(/no optimism/);
  });
});
