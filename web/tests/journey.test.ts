import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { beadTAt, beatsOf, climbAt, journeyOf, keptThrough, messageAt, messagesOf, poseProgress, progressForIdea } from "@/components/replay/journey-facts";
import { parseEventsJsonl } from "@/lib/events";
import { buildView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";
import { layoutSurvey } from "@/lib/survey/layout";
import { climbPointXZ } from "@/lib/survey/poses";

function load(name: string) {
  const dir = path.join(__dirname, "../public/replays", name);
  const events = parseEventsJsonl(readFileSync(path.join(dir, "events.jsonl"), "utf8"));
  const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
  return buildView(events, record);
}

const STEP = 0.0005;
const grid = (f: (p: number) => void) => {
  for (let p = 0; p <= 1 + 1e-9; p += STEP) f(Math.min(1, p));
};

for (const name of ["breast_cancer", "housing", "wine", "iris_with_missing"]) {
  describe(`replay journey: ${name}`, () => {
    const view = load(name);
    const J = journeyOf(view);
    const beats = beatsOf(J, { stop: !!view.stop, final: !!view.final });
    const order = messagesOf(J, beats);

    it("the run is complete enough for every beat", () => {
      expect(J.n).toBe(view.experiments.length);
      expect(beats.map((b) => b.kind)).toEqual(["summary", "climb", "noise", "stop", "test", "map", "record"]);
      expect(J.climbVh).toBeGreaterThanOrEqual(200);
      expect(J.climbVh).toBeLessThanOrEqual(1100);
    });

    it("the ideas after the last keep share ONE message; every idea up to the last keep has its own", () => {
      expect(J.tailN).toBe(J.n - 1 - J.lastKeep);
      expect(order.filter((m) => m === "tail")).toHaveLength(J.tailN ? 1 : 0);
      expect(order.filter((m) => m.startsWith("idea-"))).toHaveLength(J.lastKeep + 1);
      for (let i = J.lastKeep + 1; i < J.n; i++) expect(messageAt(J, "climb", progressForIdea(J, i))).toBe("tail");
      // the tail is about two beats long, not a page per miss
      expect((1 - J.tailFrom) * J.climbVh).toBeLessThanOrEqual(300);
    });

    it("the rail is total and monotonic down the page, and visits every message once, in order", () => {
      const seen: string[] = [];
      for (const b of beats) {
        const ps = b.kind === "climb" ? Array.from({ length: Math.round(1 / STEP) + 1 }, (_, i) => i * STEP) : [0, 0.5, 1];
        for (const p of [-0.5, ...ps, 1.5, NaN]) {
          const m = messageAt(J, b.kind, p);
          expect(order).toContain(m);
          if (Number.isFinite(p) && p >= 0 && p <= 1 && seen.at(-1) !== m) seen.push(m);
        }
      }
      expect(seen).toEqual(order);
    });

    it("every carded idea has room to be read (≥ 1.5 wheel ticks), and every idea is reachable by bar click / arrows", () => {
      for (let i = 0; i < J.n; i++) {
        expect(J.starts[i + 1]).toBeGreaterThan(J.starts[i]);
        if (i <= J.lastKeep) expect((J.starts[i + 1] - J.starts[i]) * J.climbVh).toBeGreaterThanOrEqual(31.9); // svh
        expect(climbAt(J, progressForIdea(J, i)).idea).toBe(i);
      }
      expect(J.starts[0]).toBe(0);
      expect(J.starts[J.n]).toBe(1);
    });

    it("the ball's place is monotonic down the page: baseline before the climb, summit after", () => {
      let prev = -1;
      for (const b of beats) {
        const ps = b.kind === "climb" ? Array.from({ length: 2001 }, (_, i) => i / 2000) : [0, 0.25, 0.5, 0.75, 1];
        for (const q of ps) {
          const t = beadTAt(J, b.kind, q);
          expect(t).toBeGreaterThanOrEqual(prev - 1e-12);
          prev = t;
        }
      }
      expect(beadTAt(J, "summary", 0)).toBe(0);
      expect(prev).toBe(J.keeps.length - 1);
    });

    it("the kept count on the card is the keeps the ball has reached (a keep is counted exactly on arrival)", () => {
      grid((p) => {
        const c = climbAt(J, p);
        expect(keptThrough(J, c.idea)).toBe(Math.floor(c.beadT + 1e-9) + 1);
      });
      // and the ball is ON keep j while keep j's card is showing for the first time
      for (let j = 1; j < J.keeps.length; j++) {
        const c = climbAt(J, J.starts[J.keeps[j]] + 1e-9);
        expect(c.idea).toBe(J.keeps[j]);
        expect(c.beadT).toBeCloseTo(j, 6);
      }
    });

    it("the ball rolls at a calm pace: constant within each leg, never more than twice the mean, never parked mid-roll", () => {
      const L = layoutSurvey(view, view);
      const arc = (p: number) => {
        const t = climbAt(J, p).beadT;
        let d = 0;
        for (let i = 0; i + 1 < L.climb.length; i++) d += Math.hypot(L.climb[i + 1][0] - L.climb[i][0], L.climb[i + 1][2] - L.climb[i][2]) * Math.min(1, Math.max(0, t - i));
        return d;
      };
      const dp = 0.002;
      const speeds: number[] = [];
      for (let p = J.rollEnd * 0.08; p + dp <= J.rollEnd * 0.92; p += dp) speeds.push((arc(p + dp) - arc(p)) / dp);
      const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      expect(Math.max(...speeds)).toBeLessThanOrEqual(2 * mean);
      expect(Math.min(...speeds)).toBeGreaterThan(0.4 * mean);
      // the ball reaches the summit exactly where the roll ends, and stays there through the tail
      expect(climbAt(J, J.rollEnd).beadT).toBe(J.keeps.length - 1);
      const [x0, z0] = climbPointXZ(L.climb, climbAt(J, 0).beadT);
      const [x1, z1] = climbPointXZ(L.climb, climbAt(J, 1).beadT);
      expect(Math.hypot(x1 - x0, z1 - z0)).toBeGreaterThan(1);
    });

    it("the camera's climb progress is monotonic, and the aim never snaps at a slice edge", () => {
      let prev = -1;
      grid((p) => {
        const q = poseProgress(J, "climb", p);
        expect(q).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = q;
      });
      for (let i = J.lastKeep; i < J.n; i++) {
        expect(climbAt(J, J.starts[i] + 1e-9).aimW).toBeLessThan(0.01);
        if (i + 1 < J.n) expect(climbAt(J, J.starts[i + 1] - 1e-9).aimW).toBeLessThan(0.01);
      }
    });
  });
}
