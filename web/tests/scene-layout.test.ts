import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventsJsonl } from "@/lib/events";
import { buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { layoutReef, MIN_KEPT_RISE, MIN_SHOOT_RISE, pointOnBranch, reefScale, SEABED_Y, SHOOT_LEN, hash01, shootVigour } from "@/lib/scene/layout";

const dir = path.join(__dirname, "../public/replays/breast_cancer");
const events = parseEventsJsonl(readFileSync(path.join(dir, "events.jsonl"), "utf8"));
const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
const full = buildView(events, record);
const stoppedAt = events.findIndex((e) => e.type === "stopped");

describe("layoutReef (breast_cancer replay)", () => {
  const layout = layoutReef(full);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));

  it("follows the real parent topology: kept branches start at the parent's tip, side-shoots on its stem", () => {
    expect(layout.nodes).toHaveLength(full.experiments.length);
    for (const x of full.experiments) {
      const n = byId.get(x.id)!;
      expect(n.parentId).toBe(x.parentId);
      if (!x.parentId) {
        expect(n.base[1]).toBe(SEABED_Y);
        continue;
      }
      const p = byId.get(x.parentId)!;
      if (x.status === "keep") expect(n.base).toEqual(p.tip);
      else {
        // The attach point lies on the parent's curve: some t in [0,1] reproduces it.
        let best = Infinity;
        for (let i = 0; i <= 400; i++) {
          const q = pointOnBranch(p.base, p.tip, hash01(p.id), i / 400);
          best = Math.min(best, Math.hypot(q[0] - n.base[0], q[1] - n.base[1], q[2] - n.base[2]));
        }
        expect(best).toBeLessThan(0.02);
      }
    }
  });

  it("grows upward: kept stems climb with score, side-shoots are short and never droop", () => {
    const { heightOf } = reefScale(full);
    for (const x of full.experiments) {
      const n = byId.get(x.id)!;
      const rise = n.tip[1] - n.base[1];
      expect(rise).toBeGreaterThan(0);
      if (x.status === "keep" && x.parentId) expect(n.tip[1]).toBeCloseTo(Math.max(heightOf(x.cv!.mean), n.base[1] + MIN_KEPT_RISE), 5);
      if (x.status !== "keep") {
        expect(rise).toBeGreaterThanOrEqual(MIN_SHOOT_RISE - 1e-9);
        expect(Math.hypot(n.tip[0] - n.base[0], rise, n.tip[2] - n.base[2])).toBeLessThanOrEqual(SHOOT_LEN[1] + 1e-6);
      }
    }
    // Kept heights are monotone in the oriented CV mean (height = score), and the best tip is the crown.
    const kept = full.experiments.filter((x) => x.status === "keep").sort((a, b) => a.cv!.mean - b.cv!.mean);
    for (let i = 1; i < kept.length; i++) expect(heightOf(kept[i].cv!.mean)).toBeGreaterThan(heightOf(kept[i - 1].cv!.mean));
    // The best tip is the crown: side-shoots never overtop their stem by more than the minimum shoot.
    expect(byId.get("e012")!.tip[1]).toBe(Math.max(...layout.nodes.map((n) => n.tip[1])));
    for (const n of layout.nodes) if (n.status !== "keep" && n.parentId) expect(n.tip[1]).toBeLessThanOrEqual(byId.get(n.parentId)!.tip[1] + MIN_SHOOT_RISE);
    // Vigour is data-driven: near-misses grow long, bad ideas stay stubby (horizontal reach is never capped).
    const reach = (id: string) => Math.hypot(byId.get(id)!.tip[0] - byId.get(id)!.base[0], byId.get(id)!.tip[2] - byId.get(id)!.base[2]);
    const disc = full.experiments.filter((x) => x.status === "discard" && x.parentId === "e012");
    const parentMean = full.experiments.find((x) => x.id === "e012")!.cv!.mean;
    const near = disc.reduce((a, b) => (b.cv!.mean > a.cv!.mean ? b : a));
    const far = disc.reduce((a, b) => (b.cv!.mean < a.cv!.mean ? b : a));
    expect(near.cv!.mean - parentMean).toBeGreaterThan(far.cv!.mean - parentMean);
    expect(reach(near.id)).toBeGreaterThan(reach(far.id));
    expect(shootVigour(parentMean, parentMean, 0.01)).toBe(1);
    expect(shootVigour(parentMean - 0.01, parentMean, 0.01)).toBe(0);
  });

  it("clamps the noise halo (diameter) to 30% of the current reef height", () => {
    const early = layoutReef(buildView(events.slice(0, 6), record), full);
    const h = Math.max(...early.nodes.map((n) => n.tip[1]));
    expect(2 * early.haloRadius).toBeLessThanOrEqual(0.3 * Math.max(1, h) + 1e-6);
  });

  it("marks the best lineage", () => {
    expect(layout.bestId).toBe("e012");
    const lineage = layout.nodes.filter((n) => n.isBest).map((n) => n.id);
    expect(lineage).toContain("e012");
    for (const id of lineage) {
      const p = byId.get(id)!.parentId;
      if (p) expect(byId.get(p)!.isBest).toBe(true);
    }
    expect(byId.get("e001")!.isBest).toBe(false);
  });

  it("has no surface before the stop, and the mapped fitted asymptote after it", () => {
    expect(layoutReef(buildView(events.slice(0, stoppedAt), record)).surfaceY).toBeNull();
    const stopped = buildView(events.slice(0, stoppedAt + 1), record);
    expect(stopped.phase).toBe("stopped");
    const sat = stopped.stop!.signals.find((s) => s.key === "saturation")!.value as number;
    const bestMean = stopped.experiments.find((x) => x.id === stopped.bestId)!.cv!.mean;
    const { heightOf } = reefScale(stopped);
    const s = layoutReef(stopped);
    expect(s.surfaceY).toBeCloseTo(heightOf(bestMean + sat), 5);
    // The asymptote sits above the best tip — the ceiling is just overhead.
    expect(s.surfaceY!).toBeGreaterThan(byId.get("e012")!.tip[1]);
    expect(s.testY).toBeNull();
    expect(layout.testY).not.toBeNull();
    expect(layout.testY!).toBeCloseTo(heightOf(full.final!.testScore), 5);
  });

  it("falls back to best mean + SE when there is no saturation value", () => {
    const v = structuredClone(full);
    v.stop!.signals = v.stop!.signals.map((s) => (s.key === "saturation" ? { ...s, value: null } : s));
    const best = v.experiments.find((x) => x.id === v.bestId)!.cv!;
    expect(layoutReef(v).surfaceY).toBeCloseTo(reefScale(v).heightOf(best.mean + best.se), 5);
  });

  it("is deterministic, and stable across playback when given the full-run domain", () => {
    expect(layoutReef(full)).toEqual(layoutReef(buildView(events, record)));
    const mid = buildView(events.slice(0, Math.floor(events.length / 2)), record);
    const midLayout = layoutReef(mid, full);
    for (const n of midLayout.nodes) {
      const x = mid.experiments.find((e) => e.id === n.id)!;
      if (x.status !== "running") expect(n.tip).toEqual(byId.get(n.id)!.tip);
    }
  });
});
