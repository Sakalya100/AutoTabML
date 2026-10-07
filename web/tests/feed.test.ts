import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventsJsonl } from "@/lib/events";
import { buildFeed, feedSignature, inFlight, parseGateReason, type ExperimentItem } from "@/lib/feed";

const load = (p: string) => parseEventsJsonl(readFileSync(path.join(__dirname, p), "utf8"));
const bc = load("../public/replays/breast_cancer/events.jsonl");
const iris = load("../scripts/fixtures/iris-heuristic/events.jsonl");
const exps = (items: ReturnType<typeof buildFeed>) => items.filter((i): i is ExperimentItem => i.kind === "experiment");

describe("buildFeed on the breast_cancer replay", () => {
  const items = buildFeed(bc);

  it("emits run started, one group per experiment, then stopped and finished, in order", () => {
    expect(items[0].kind).toBe("run_started");
    expect(items.at(-2)?.kind).toBe("stopped");
    expect(items.at(-1)?.kind).toBe("finished");
    expect(exps(items)).toHaveLength(37);
    expect(items).toHaveLength(40);
    expect(exps(items).map((x) => x.index)).toEqual([...Array(37).keys()]);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it("summarises what the agent sees at the start", () => {
    const start = items[0];
    if (start.kind !== "run_started") throw new Error("expected run_started");
    expect(start.nRows).toBe(569);
    expect(start.nCols).toBe(31);
    expect(start.target).toBe("malignant");
    expect(start.metric).toBe("roc_auc");
    expect(start.columnKinds.reduce((a, [, n]) => a + n, 0)).toBe(30); // target excluded
  });

  it("every experiment is fully decided with its score and the gate's parsed reason", () => {
    for (const x of exps(items)) {
      expect(x.stage).toBe("decided");
      expect(x.scored).not.toBeNull();
      expect(x.attempts.length).toBeGreaterThan(0);
    }
    const e001 = exps(items).find((x) => x.id === "e001")!;
    expect(e001.decision?.verdict).toBe("discard");
    expect(e001.decision?.gate).toEqual({ label: "not significant", p: 0.228, gainSe: 0.94 });
    const e012 = exps(items).find((x) => x.id === "e012")!;
    expect(e012.decision?.verdict).toBe("keep");
    expect(e012.decision?.newBest).toBe(true);
    expect(e012.decision?.gate.label).toBe("improvement");
    expect(
      exps(items)
        .filter((x) => x.decision?.newBest)
        .map((x) => x.id),
    ).toEqual(["e000", "e003", "e005", "e012"]);
  });

  it("closes with the stop signals and the locked test", () => {
    const stop = items.at(-2)!;
    if (stop.kind !== "stopped") throw new Error("expected stopped");
    expect(stop.reason).toBe("ceiling");
    expect(stop.signals.filter((s) => s.fired).map((s) => s.key)).toEqual(["noise_floor", "saturation", "exploration"]);
    const fin = items.at(-1)!;
    if (fin.kind !== "finished") throw new Error("expected finished");
    expect(fin.bestId).toBe("e012");
    expect(fin.gap).toBeLessThan(0);
  });

  it("any prefix yields a consistent partial feed (simulation steps)", () => {
    let prevSig = "";
    for (let i = 0; i <= bc.length; i++) {
      const f = buildFeed(bc.slice(0, i));
      const sig = feedSignature(f);
      expect(sig).not.toBe(prevSig); // every event changes something visible
      prevSig = sig;
      const fly = inFlight(f);
      if (fly) expect(f.at(-1)).toBe(fly);
    }
    // just after e004 starts: in flight, running in the sandbox
    const at = bc.findIndex((e) => e.type === "experiment_started" && e.exp_id === "e004") + 1;
    const mid = buildFeed(bc.slice(0, at));
    expect(inFlight(mid)?.id).toBe("e004");
    expect(inFlight(mid)?.stage).toBe("running");
    expect(buildFeed(bc.slice(0, at + 2)).at(-1)).toMatchObject({ id: "e004", stage: "scored" });
  });
});

describe("buildFeed with crashes and repairs", () => {
  it("keeps every failed attempt and the crash verdict without a score", () => {
    const e007 = exps(buildFeed(iris)).find((x) => x.id === "e007")!;
    expect(e007.attempts.map((a) => a.ok)).toEqual([false, false]);
    expect(e007.scored).toBeNull();
    expect(e007.decision?.verdict).toBe("crash");
    expect(e007.attempts[0].errorTail).toContain("Traceback");
  });
});

describe("parseGateReason", () => {
  it("is lenient with free-text reasons", () => {
    expect(parseGateReason("Baseline is always kept.")).toEqual({ label: null, p: null, gainSe: null });
    expect(parseGateReason("Paired t-test over 10 folds p=0.004; gain 0.0312").p).toBe(0.004);
    expect(parseGateReason("not significant: p=1 >= alpha=0.1; gain 0 (+0.00 SE, SE=0.002343)")).toEqual({ label: "not significant", p: 1, gainSe: 0 });
    expect(parseGateReason("x: gain -0.005605 (-6.03 SE, SE=0.0009291), p=0.917").gainSe).toBe(-6.03);
    expect(parseGateReason(null).label).toBeNull();
  });
});
