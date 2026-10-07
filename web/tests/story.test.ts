import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventsJsonl } from "@/lib/events";
import { buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import {
  answerKind,
  askedOf,
  beadAt,
  humanName,
  keptIndices,
  outcomeLine,
  outcomeOf,
  plainGap,
  plainIdea,
  plainVerdict,
  proposerNote,
  stopPhrase,
} from "@/lib/story";

function load(name: string) {
  const dir = path.join(__dirname, "../public/replays", name);
  const events = parseEventsJsonl(readFileSync(path.join(dir, "events.jsonl"), "utf8"));
  const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
  return buildView(events, record);
}
const bc = load("breast_cancer");
const housing = load("housing");
const wine = load("wine");

describe("run summary", () => {
  it("names datasets in sentence case", () => {
    expect(humanName("breast_cancer")).toBe("Breast cancer");
    expect(humanName("iris_with_missing")).toBe("Iris with missing");
  });
  it("describes what was asked from the recorded profile only", () => {
    expect(askedOf(bc)).toEqual({ target: "malignant", kind: "yes or no", rows: 569, features: 30 });
    expect(askedOf(wine).kind).toBe("one of 3 kinds");
    expect(askedOf(housing).kind).toBe("a number");
    expect(answerKind(null)).toBeNull();
  });
  it("counts what happened and says 'on its own' only for the ceiling", () => {
    const o = outcomeOf(bc);
    expect(o).toMatchObject({ tried: 37, kept: 4, crashed: 0, stop: "stopped on its own" });
    expect(outcomeLine(o)).toBe("37 ideas tried, 4 kept, stopped on its own");
    expect(stopPhrase("max_experiments", 10)).toBe("stopped at its budget of 10 ideas");
    expect(stopPhrase(null)).toBeNull();
  });
  it("explains the optimism gap against the run's own noise", () => {
    expect(plainGap("roc_auc", -0.0075, 0.0009)).toMatch(/better than its own checks/);
    expect(plainGap("roc_auc", 0.001, 0.0009)).toMatch(/within the normal wobble/);
    expect(plainGap("roc_auc", 0.02, 0.0009)).toMatch(/a little too high/);
    expect(plainGap("roc_auc", 0, 0.001)).toMatch(/Exactly/);
  });
  it("words the proposer note plainly", () => {
    expect(proposerNote("heuristic")).toBe("Recorded without an LLM: ideas come from a built-in search.");
    expect(proposerNote(null)).toBeNull();
  });
});

describe("plainIdea", () => {
  const idea = (title: string, category = "hyperparameters") => plainIdea({ title, category } as never);
  it("rewrites the engine's idea titles", () => {
    expect(idea("Baseline: unmodified starter solution", "baseline")).toBe("a simple starting model");
    expect(idea("Switch model family: HistGradientBoosting -> linear model", "model_family")).toBe("switching to a linear model");
    expect(idea("Switch model family: linear model -> RandomForest", "model_family")).toBe("switching to a random forest");
    expect(idea("HistGradientBoosting: set learning_rate 0.1 -> 0.05")).toBe("lowering the learning rate (0.1 → 0.05)");
    expect(idea("linear model: set C 1.0 -> 3.0")).toBe("raising the regularisation strength (1.0 → 3.0)");
    expect(idea("Random HistGradientBoosting configuration #26")).toBe("a random gradient boosting setup");
    expect(idea("Soft-voting ensemble of top kept solutions (e012, e005, e000)", "ensembling")).toBe("averaging the best models so far");
    expect(idea("Stacking ensemble of top kept solutions (e008)", "ensembling")).toBe("stacking the best models so far");
    expect(idea("Feature engineering: add row mean/std features", "feature_engineering")).toBe("new features: add row mean/std features");
    expect(idea("Numeric scaling: standard -> power", "preprocessing")).toBe("a different number scaling (standard → power)");
  });
  it("shows unknown titles as written", () => {
    expect(idea("Target-encode the zip code", "preprocessing")).toBe("target-encode the zip code");
  });
});

describe("plainVerdict", () => {
  const byId = (id: string) => bc.experiments.find((x) => x.id === id)!;
  it("reads the gate's reason", () => {
    expect(plainVerdict(byId("e000"))).toMatchObject({ tone: "kept", text: "The starting point" });
    expect(plainVerdict(byId("e003"))).toMatchObject({ tone: "kept", text: "Just as good, and simpler" });
    expect(plainVerdict(byId("e012"))).toMatchObject({ tone: "kept", text: "Better by a clear margin" });
    expect(plainVerdict(byId("e005"))).toMatchObject({ tone: "kept", text: "Better, and not just luck" });
    expect(plainVerdict(byId("e001"))).toMatchObject({ tone: "dropped", text: "A little better, but it could be luck" });
    expect(plainVerdict(byId("e016"))).toMatchObject({ tone: "dropped", text: "Clearly worse" });
    expect(plainVerdict(byId("e006"))).toMatchObject({ tone: "dropped", text: "No better" });
  });
  it("handles crashes and running experiments", () => {
    expect(plainVerdict({ status: "crash", reason: "", index: 3 }).tone).toBe("broke");
    expect(plainVerdict({ status: "running", reason: "", index: 3 }).outcome).toBe("testing…");
  });
});

describe("beadAt", () => {
  const keeps = keptIndices(bc);
  it("follows the recorded keeps", () => expect(keeps).toEqual([0, 3, 5, 12]));
  it("rests on the latest keep across discards and rolls only into the next keep", () => {
    expect(beadAt(keeps, 0)).toBe(0);
    expect(beadAt(keeps, 1.5)).toBe(0);
    expect(beadAt(keeps, 2.5)).toBeCloseTo(0.5); // rolling toward e003
    expect(beadAt(keeps, 3)).toBe(1);
    expect(beadAt(keeps, 11.25)).toBeCloseTo(2.25);
    expect(beadAt(keeps, 12)).toBe(3);
    expect(beadAt(keeps, 36)).toBe(3);
  });
  it("is continuous and monotonic in t", () => {
    let prev = 0;
    for (let t = 0; t <= 36; t += 0.01) {
      const b = beadAt(keeps, t);
      expect(b).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(b - prev).toBeLessThan(0.02);
      prev = b;
    }
  });
  it("is safe on empty and odd input", () => {
    expect(beadAt([], 4)).toBe(0);
    expect(beadAt(keeps, Number.NaN)).toBe(0);
    expect(beadAt(keeps, -3)).toBe(0);
  });
});

describe("displayScore", () => {
  it("writes large scores out in full and keeps small ones as the metric formats them", async () => {
    const { displayScore } = await import("@/lib/story");
    expect(displayScore("rmse", -1000342.4)).toBe("1,000,342");
    expect(displayScore("roc_auc", 0.99361)).toBe("0.9936");
    expect(displayScore("roc_auc", null)).toBe("—");
  });
});
