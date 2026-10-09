/**
 * A run where the agents never beat the starting model (only e000 kept): a real recording, every later idea dropped.
 * Live runs can end like this, so the replay journey, the survey layout and the copy must treat it as a normal story.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { beadTAt, beatsOf, climbAt, journeyOf, messageAt, messagesOf } from "@/components/replay/journey-facts";
import { parseEventsJsonl } from "@/lib/events";
import { buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { plainStopSignals } from "@/lib/story";
import { layoutSurvey } from "@/lib/survey/layout";

const dir = path.join(__dirname, "../scripts/fixtures/wine-baseline-only");
const events = parseEventsJsonl(readFileSync(path.join(dir, "events.jsonl"), "utf8"));
const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
const view = buildView(events, record);

const finiteDeep = (o: unknown, at = "root"): string[] => {
  if (typeof o === "number") return Number.isFinite(o) ? [] : [at];
  if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => finiteDeep(v, `${at}.${k}`));
  return [];
};

describe("a run that kept only its starting model", () => {
  const J = journeyOf(view);

  it("is the case under test: one keep (the baseline), every later idea dropped", () => {
    expect(view.experiments.filter((x) => x.status === "keep").map((x) => x.id)).toEqual(["e000"]);
    expect(J.keeps).toEqual([0]);
    expect(J.tailN).toBe(view.experiments.length - 1);
  });

  it("the journey's numbers are finite and the idea slices strictly increase", () => {
    expect(finiteDeep(J)).toEqual([]);
    for (let i = 0; i < J.n; i++) expect(J.starts[i + 1]).toBeGreaterThan(J.starts[i]);
    expect(J.climbVh).toBeGreaterThan(0);
  });

  it("the ball stays on the baseline while the tail walks through every dropped idea", () => {
    const seen = new Set<number>();
    for (let p = 0; p <= 1; p += 0.001) {
      const c = climbAt(J, p);
      expect(finiteDeep(c)).toEqual([]);
      expect(c.beadT).toBe(0);
      seen.add(c.idea);
      expect(["idea-0", "tail"]).toContain(messageAt(J, "climb", p));
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([...Array(J.n).keys()]);
    const beats = beatsOf(J, { stop: !!view.stop, final: !!view.final });
    expect(messagesOf(J, beats).filter((m) => m === "tail")).toHaveLength(1);
    for (const b of beats) expect(beadTAt(J, b.kind, 0.5)).toBe(0);
  });

  it("the survey layout is finite and the ceiling sits above the ball, not on it", () => {
    const L = layoutSurvey(view);
    expect(finiteDeep({ ...L, heightOf: null })).toEqual([]);
    expect(L.cloudY).not.toBeNull();
    expect(L.cloudY!).toBeGreaterThan(L.bestY! + 1e-6);
  });

  it("the stop explanation never mentions a 'last win' that didn't happen", () => {
    for (const s of plainStopSignals(view)) expect(s.text).not.toMatch(/last win/i);
  });
});
