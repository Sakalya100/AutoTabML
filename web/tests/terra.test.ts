import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventsJsonl } from "@/lib/events";
import { buildView } from "@/lib/run-state";
import { ceilingScore, diffSize, momentFor, poseFor, slimView, surveySummary } from "@/lib/terra";
import type { RunRecord } from "@/lib/schema";

const dir = path.join(__dirname, "../public/replays/breast_cancer");
const events = parseEventsJsonl(readFileSync(path.join(dir, "events.jsonl"), "utf8"));
const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
const full = buildView(events, record);

describe("momentFor", () => {
  it("plays the ceiling when a watched run stops and the truth beam when it finishes", () => {
    expect(momentFor("running", "stopped")).toBe("ceiling");
    expect(momentFor("stopped", "finished")).toBe("truth");
    expect(momentFor("running", "finished")).toBe("truth");
  });
  it("plays nothing on a cold load or when nothing changed", () => {
    expect(momentFor("empty", "finished")).toBeNull();
    expect(momentFor("finished", "finished")).toBeNull();
    expect(momentFor("empty", "running")).toBeNull();
  });
});

describe("poseFor", () => {
  it("lets a moment win over everything", () => {
    expect(poseFor({ moment: "ceiling", staging: true, phase: "stopped" })).toBe("ceiling");
    expect(poseFor({ moment: "truth", staging: false, phase: "finished" })).toBe("truth");
  });
  it("follows the bead while a run grows on screen, else rests on the overview", () => {
    expect(poseFor({ moment: null, staging: true, phase: "running" })).toBe("climb");
    expect(poseFor({ moment: null, staging: true, phase: "empty" })).toBe("climb");
    expect(poseFor({ moment: null, staging: true, phase: "stopped" })).toBe("overview");
    expect(poseFor({ moment: null, staging: false, phase: "running" })).toBe("overview");
    expect(poseFor({ moment: null, staging: false, phase: "finished" })).toBe("overview");
  });
});

describe("ceilingScore", () => {
  it("is null until the stop rule fires, then sits at or above the best mean", () => {
    expect(ceilingScore(buildView(events.slice(0, 10), record))).toBeNull();
    const best = full.experiments.find((x) => x.id === full.bestId)!;
    expect(ceilingScore(full)).toBeGreaterThanOrEqual(best.cv!.mean);
  });
});

describe("diffSize", () => {
  it("counts changed lines but not file headers", () => {
    expect(diffSize(undefined)).toBe(0);
    expect(diffSize("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+c\n d")).toBe(3);
  });
});

describe("slimView", () => {
  const slim = slimView(full);
  it("drops code, rationale, error tails and the profile", () => {
    const json = JSON.stringify(slim);
    expect(json.length).toBeLessThan(JSON.stringify(full).length / 2);
    expect(slim.profile).toBeNull();
    for (const x of slim.experiments) {
      expect(x.code).toBeUndefined();
      expect(x.idea.rationale).toBe("");
      expect(x.attempts.every((a) => a.errorTail === null)).toBe(true);
    }
  });
  it("keeps everything the survey maps: ids, lineage, categories, scores, change size and the outcome", () => {
    expect(slim.experiments.map((x) => [x.id, x.parentId, x.idea.category, x.status, x.cv?.mean])).toEqual(
      full.experiments.map((x) => [x.id, x.parentId, x.idea.category, x.status, x.cv?.mean]),
    );
    expect(slim.experiments.map((x) => diffSize(x.diff))).toEqual(full.experiments.map((x) => diffSize(x.diff)));
    expect(slim.bestId).toBe(full.bestId);
    expect(slim.stop).toEqual(full.stop);
    expect(slim.final).toEqual(full.final);
    expect(slim.phase).toBe("finished");
  });
});

describe("surveySummary", () => {
  it("describes the map for screen readers", () => {
    const s = surveySummary(full);
    expect(s).toMatch(/^Survey of 13 probes, 3 kept/);
    expect(s).toContain("test");
    expect(surveySummary(buildView([], null))).toMatch(/not landed a probe/);
  });
});
