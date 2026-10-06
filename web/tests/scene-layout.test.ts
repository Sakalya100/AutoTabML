import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventsJsonl } from "@/lib/events";
import { buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { bezierPoint, bezierTangent, layoutReef, MAX_RADIUS, MIN_KEPT_RISE, MIN_RADIUS, MIN_SHOOT_RISE, nodeControls, reefScale, SEABED_Y, SHOOT_LEN, shootVigour } from "@/lib/scene/layout";
import { tipLeaves, twigSpecs } from "@/lib/scene/twigs";

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
          const q = bezierPoint(nodeControls(p), i / 400);
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

  it("grows branches out of their stems with tangent continuity, bending toward the light", () => {
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const n of layout.nodes) {
      const c = nodeControls(n);
      expect(n.c1 && n.c2).toBeTruthy();
      const start = bezierTangent(c, 0);
      if (!n.parentId) {
        expect(start[1]).toBeGreaterThan(0.99); // the trunk rises straight out of the seabed
        continue;
      }
      const p = byId.get(n.parentId)!;
      const pt = bezierTangent(nodeControls(p), n.attachT ?? 1);
      // Kept limbs continue their parent's direction; side-shoots leave at an angle but never against the stem.
      expect(dot(start, pt)).toBeGreaterThan(n.status === "keep" ? 0.55 : -0.05);
      // Arrival leans up (phototropism).
      expect(bezierTangent(c, 1)[1]).toBeGreaterThan(0);
    }
  });

  it("tapers by the pipe model: a stem is at least as thick as what it carries", () => {
    for (const n of layout.nodes) {
      expect(n.rBase!).toBeGreaterThanOrEqual(n.rTip!);
      expect(n.rTip!).toBeGreaterThanOrEqual(MIN_RADIUS);
      expect(n.rBase!).toBeLessThanOrEqual(MAX_RADIUS);
      const kids = layout.nodes.filter((k) => k.parentId === n.id);
      // Leonardo: cross-section of the stem ≈ the sum of its branches' (within the radius cap).
      if (kids.length && n.rBase! < MAX_RADIUS) expect(n.rBase! ** 2).toBeGreaterThanOrEqual(kids.reduce((a, k) => a + k.rBase! ** 2, 0) - 1e-9);
      // A kept limb starts no thicker than the tip it grows from: no step at the junction.
      for (const k of kids) if ((k.attachT ?? 0) >= 1) expect(k.rBase!).toBeLessThanOrEqual(n.rTip! + 1e-9);
    }
    const root = layout.nodes.find((n) => !n.parentId)!;
    expect(root.rBase).toBe(Math.max(...layout.nodes.map((n) => n.rBase!)));
    // Plain JSON (the replays gallery computes layouts on the server).
    expect(JSON.parse(JSON.stringify(layout))).toEqual(layout);
  });

  it("decorates real branches with deterministic, data-driven twigs (never extra experiments)", () => {
    for (const n of layout.nodes) {
      const a = twigSpecs(n);
      expect(twigSpecs(n)).toEqual(a);
      if (n.status === "crash" || n.status === "running") expect(a).toHaveLength(0);
      for (const [i, t] of a.entries()) {
        expect(t.parent).toBeLessThan(i);
        expect(t.t).toBeGreaterThan(0);
        expect(t.t).toBeLessThan(1);
        expect(t.level).toBeLessThanOrEqual(3);
      }
      expect(twigSpecs(n, true).length).toBeLessThanOrEqual(a.length);
    }
    // Vigour drives the crown: a near-miss discard carries at least as many twigs as a dud.
    const disc = layout.nodes.filter((n) => n.status === "discard");
    const hi = disc.reduce((a, b) => (b.vigour! > a.vigour! ? b : a));
    const lo = disc.reduce((a, b) => (b.vigour! < a.vigour! ? b : a));
    expect(twigSpecs(hi).length).toBeGreaterThanOrEqual(twigSpecs(lo).length);
    // Kept branches leaf out; discards bud a couple of leaves that fall as they wither; crashes carry none.
    expect(tipLeaves({ status: "keep", vigour: 1 })).toBeGreaterThan(tipLeaves({ status: "discard", vigour: 1 }));
    expect(tipLeaves({ status: "crash", vigour: 0 })).toBe(0);
  });
});

