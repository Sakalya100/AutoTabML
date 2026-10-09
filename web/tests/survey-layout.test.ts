import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { growthSteps } from "@/components/landing/facts";
import { parseEventsJsonl } from "@/lib/events";
import { buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { buildHeightfield, fieldWindow, sampleField } from "@/lib/survey/heightfield";
import { H_HI, H_LO, layoutSurvey, MIN_SEP, niceStep, projectPositions, terrainKey } from "@/lib/survey/layout";
import { cameraPose } from "@/lib/survey/poses";

function load(name: string) {
  const dir = path.join(__dirname, "../public/replays", name);
  const events = parseEventsJsonl(readFileSync(path.join(dir, "events.jsonl"), "utf8"));
  const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
  return { events, record, full: buildView(events, record) };
}

const bc = load("breast_cancer");
const stoppedAt = bc.events.findIndex((e) => e.type === "stopped") + 1;

describe("layoutSurvey (breast_cancer replay)", () => {
  const L = layoutSurvey(bc.full);
  const byId = new Map(L.probes.map((p) => [p.id, p]));

  it("is deterministic", () => {
    const a = layoutSurvey(bc.full);
    const b = layoutSurvey(buildView(bc.events, bc.record));
    expect(JSON.stringify(a.probes)).toBe(JSON.stringify(b.probes));
    expect(a.bounds).toEqual(b.bounds);
  });

  it("has one probe per experiment, on the real parent topology", () => {
    expect(L.probes).toHaveLength(13);
    for (const x of bc.full.experiments) expect(byId.get(x.id)!.parentId).toBe(x.parentId);
    expect(L.probes[0].pos[0]).toBe(0);
    expect(L.probes[0].pos[2]).toBe(0);
  });

  it("heights are the real CV means on a linear, domain-wide scale", () => {
    for (const x of bc.full.experiments) {
      const p = byId.get(x.id)!;
      expect(p.pos[1]).toBeCloseTo(L.heightOf(x.cv!.mean), 10);
    }
    const ys = L.probes.map((p) => p.pos[1]);
    expect(Math.min(...ys)).toBeCloseTo(H_LO, 10);
    expect(Math.max(...ys)).toBeCloseTo(H_HI, 10);
    // Not clamped: a score outside the CV range extrapolates.
    expect(L.heightOf(L.domain.lo - (L.domain.hi - L.domain.lo))).toBeCloseTo(H_LO - (H_HI - H_LO), 8);
  });

  it("keeps a minimum separation between all probes", () => {
    let min = Infinity;
    for (let i = 0; i < L.probes.length; i++)
      for (let j = 0; j < i; j++) {
        const a = L.probes[i].pos;
        const b = L.probes[j].pos;
        min = Math.min(min, Math.hypot(a[0] - b[0], a[2] - b[2]));
      }
    expect(min).toBeGreaterThanOrEqual(MIN_SEP - 1e-9);
  });

  it("the bead climbs through the keeps and rests on the best", () => {
    const kept = ["e000", "e001", "e012"];
    expect(L.climb).toEqual(kept.map((id) => byId.get(id)!.pos));
    expect(L.bead).toEqual(byId.get("e012")!.pos);
    expect(byId.get("e012")!.isBest).toBe(true);
  });

  it("mist = best SE; clouds only after the stop, at bestMean + max(saturation, SE)", () => {
    expect(L.mist).toBeCloseTo(0.00191750429270086 * L.unitsPerScore, 8);
    // the fitted curve predicts only 3.3e-6 more, less than the noise floor, so the ceiling sits one SE above the best
    expect(L.cloudY).toBeCloseTo(L.heightOf(0.9959471264367815 + Math.max(3.321275108270072e-6, 0.00191750429270086)), 8);
    const before = layoutSurvey(buildView(bc.events.slice(0, stoppedAt - 1)), bc.full);
    expect(before.cloudY).toBeNull();
    const at = layoutSurvey(buildView(bc.events.slice(0, stoppedAt)), bc.full);
    expect(at.cloudY).toBeCloseTo(L.cloudY!, 10);
    expect(at.selectY).toBeNull();
    expect(at.testY).toBeNull();
  });

  it("select / test markers come from the final scores", () => {
    expect(L.selectY).toBeCloseTo(L.heightOf(1), 8);
    expect(L.testY).toBeCloseTo(L.heightOf(0.9918981481481481), 8);
  });

  it("is prefix-stable: playback never moves a probe or rescales heights", () => {
    for (const s of growthSteps(bc.events)) {
      const v = buildView(bc.events.slice(0, s.cursor));
      const P = layoutSurvey(v, bc.full);
      for (const p of P.probes) {
        const q = byId.get(p.id)!;
        expect(p.pos[0]).toBe(q.pos[0]);
        expect(p.pos[2]).toBe(q.pos[2]);
        if (p.score01 != null) expect(p.pos[1]).toBeCloseTo(q.pos[1], 12);
      }
      expect(P.bounds).toEqual(L.bounds);
    }
    // Projection alone is prefix-stable without a domain too.
    const all = projectPositions(bc.full.experiments);
    const half = projectPositions(bc.full.experiments.slice(0, 7));
    for (const [id, p] of half) expect(all.get(id)).toEqual(p);
  });

  it("contours sit on round score values", () => {
    expect(niceStep(0.0111)).toBeCloseTo(0.001, 12);
    expect(L.contour.step).toBeCloseTo(L.contour.scoreStep * L.unitsPerScore, 10);
  });

  it("frames every pose with finite numbers", () => {
    for (const pose of ["orbit", "approach", "first-probe", "climb", "mist", "ceiling", "truth", "chart", "overview"] as const)
      for (const t of [0, 0.5, 1])
        for (const aspect of [1.6, 0.46]) {
          const c = cameraPose(pose, t, { frame: L, now: L, aspect });
          for (const n of [...c.pos, ...c.target, c.fov]) expect(Number.isFinite(n)).toBe(true);
        }
  });
});

describe("layoutSurvey (other replays)", () => {
  for (const name of ["housing", "iris_with_missing", "wine"]) {
    it(`${name}: finite, separated, clouds only when stopped`, () => {
      const r = load(name);
      const L = layoutSurvey(r.full);
      expect(L.probes).toHaveLength(r.full.experiments.length);
      for (const p of L.probes) for (const n of p.pos) expect(Number.isFinite(n)).toBe(true);
      expect(L.cloudY).not.toBeNull();
      // above the best by at least the noise floor, even when the fitted curve predicts no more gain (wine)
      expect(L.cloudY!).toBeGreaterThan(L.bestY!);
      expect(Number.isFinite(L.testY!)).toBe(true);
      const empty = layoutSurvey(buildView(r.events.slice(0, 1)), r.full);
      expect(empty.bead).toBeNull();
      expect(empty.cloudY).toBeNull();
    });
  }
});

describe("heightfield", () => {
  const L = layoutSurvey(bc.full);
  const w = fieldWindow(L.bounds, 256);

  it("passes (near-)exactly through every probe height", () => {
    const f = buildHeightfield(L, w);
    // within ~5% of the 0.7–3.9 height range (worst probe on the breast_cancer replay: 0.152)
    for (const p of L.probes) expect(Math.abs(sampleField(f, w, p.pos[0], p.pos[2]) - p.pos[1])).toBeLessThan(0.16);
  });

  it("reveal mask is ~1 at probes and 0 far away", () => {
    const f = buildHeightfield(L, w);
    for (const p of L.probes) expect(sampleField(f, w, p.pos[0], p.pos[2], 1)).toBeGreaterThan(0.95);
    expect(sampleField(f, w, w.minX + 0.1, w.minZ + 0.1, 1)).toBe(0);
  });

  it("is deterministic, writes in place and builds in a few ms", () => {
    const out = new Float32Array(256 * 256 * 2);
    buildHeightfield(L, w, out); // warm the base-relief cache
    // Median of single builds: robust to a noisy shared CI runner. Locally ~2 ms; the budget is a regression guard
    // (it runs once per landed probe), not a benchmark.
    const n = 11;
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      expect(buildHeightfield(L, w, out)).toBe(out);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const ms = times[Math.floor(times.length / 2)];
    expect(ms).toBeLessThan(process.env.CI ? 40 : 15);
    const again = buildHeightfield(L, w);
    expect(again).toEqual(out);
    const lite = fieldWindow(L.bounds, 128);
    expect(buildHeightfield(L, lite)).toHaveLength(128 * 128 * 2);
  });

  it("the terrain key changes only when the probe set does", () => {
    const a = layoutSurvey(buildView(bc.events.slice(0, 40)), bc.full);
    const b = layoutSurvey(buildView(bc.events.slice(0, 40)), bc.full);
    expect(terrainKey(a)).toBe(terrainKey(b));
    expect(terrainKey(a)).not.toBe(terrainKey(L));
  });
});
