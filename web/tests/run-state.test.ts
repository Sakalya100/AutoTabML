import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventsJsonl } from "@/lib/events";
import { bestTrajectory, buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";

const dir = path.join(__dirname, "../scripts/fixtures/iris-heuristic");
const events = parseEventsJsonl(readFileSync(path.join(dir, "events.jsonl"), "utf8"));
const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;

describe("buildView", () => {
  it("folds the full fixture into a finished run that agrees with run.json", () => {
    const v = buildView(events, record);
    expect(v.phase).toBe("finished");
    expect(v.experiments.map((x) => x.status)).toEqual(record.experiments!.map((x) => x.status));
    expect(v.bestId).toBe(record.best_exp_id);
    expect(v.final?.testScore).toBe(record.final?.test_score);
    expect(v.stop?.signals.map((s) => s.key)).toEqual(["noise_floor", "saturation", "exploration", "external_ref"]);
    expect(v.experiments.find((x) => x.status === "crash")?.attempts.every((a) => !a.ok)).toBe(true);
    expect(v.experiments[3].diff).toContain("+++");
  });
  it("handles any prefix (replay scrubbing) without throwing", () => {
    for (let i = 0; i <= events.length; i++) {
      const v = buildView(events.slice(0, i), record);
      expect(v.eventCount).toBe(i);
    }
    const mid = buildView(events.slice(0, 6), record);
    expect(mid.phase).toBe("running");
    expect(mid.current?.status).toBe("running");
    expect(mid.final).toBeNull();
  });
  it("best-so-far never gets worse (oriented)", () => {
    const t = bestTrajectory(buildView(events));
    for (let i = 1; i < t.length; i++) expect(t[i].mean).toBeGreaterThanOrEqual(t[i - 1].mean);
  });
});
