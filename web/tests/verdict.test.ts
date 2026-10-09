import { describe, expect, it } from "vitest";
import { isNewBest, parseGate, plainGateReason, verdictText } from "@/lib/verdict";

// Real gate reasons, as the engine wrote them (breast_cancer replay; penguins and Titanic live sessions).
const BC_E003 = "simplification: fit time 0.09325s->0.0361s; gain -0.0004533 (-0.19 SE, SE=0.002412), p=0.637, select 0.9867 vs best 0.9884 (floor 0.986)";
const BC_E005 = "improvement: gain 0.001819 (+0.72 SE, SE=0.002512), p=0.0234, select 0.9873 vs best 0.9867 (floor 0.9842)";
const BC_E016 = "not significant: p=0.917 >= alpha=0.1; gain -0.005605 (-6.03 SE, SE=0.0009291), p=0.917, select 0.9925 vs best 0.9861 (floor 0.9852)";
const BC_E006 = "not significant: p=1 >= alpha=0.1; gain 0 (+0.00 SE, SE=0.002343), p=1, select 0.9873 vs best 0.9873 (floor 0.9849)";
const PENGUINS_E001 = "not significant: p=0.412 >= alpha=0.1; gain 0.01053 (+0.41 SE, SE=0.02568), p=0.412, select -0.03414 vs best -0.002979 (floor -0.02866)";

describe("parseGate", () => {
  it("reads every gate head, with or without a colon", () => {
    expect(parseGate("baseline", "keep").kind).toBe("baseline");
    expect(parseGate("single-shot solution", "keep").kind).toBe("single_shot");
    expect(parseGate(BC_E005, "keep").kind).toBe("improvement");
    expect(parseGate(BC_E003, "keep").kind).toBe("simplification");
    expect(parseGate(PENGUINS_E001, "discard").kind).toBe("not_significant");
    expect(parseGate("gain below 0.5 SE; gain 0.001 (+0.30 SE, SE=0.003), p=0.05, select n/a", "discard").kind).toBe("small_gain");
    expect(parseGate("select holdout disagrees; gain 0.01 (+1.20 SE, SE=0.008), p=0.02, select 0.8 vs best 0.9 (floor 0.85)", "discard").kind).toBe(
      "select_disagrees",
    );
    expect(parseGate("naive: cv mean improved by 0.01", "keep").kind).toBe("naive_keep");
    expect(parseGate("naive: cv mean did not improve (-0.01)", "discard").kind).toBe("naive_discard");
    expect(parseGate("runtime after 2 repair attempt(s)", "crash").kind).toBe("crash");
    expect(parseGate("proposal failed: timeout", "crash").kind).toBe("proposal_failed");
  });
  it("pulls out the gate's numbers (oriented, as written)", () => {
    expect(parseGate(PENGUINS_E001, "discard")).toMatchObject({
      p: 0.412,
      gain: 0.01053,
      gainSe: 0.41,
      se: 0.02568,
      select: { cand: -0.03414, best: -0.002979, floor: -0.02866 },
    });
    expect(parseGate(BC_E003, "keep").simpler).toEqual({ loc: null, time: [0.09325, 0.0361] });
  });
});

describe("verdictText", () => {
  it("a simplification is kept but never called a new best (breast_cancer e003: 0.9917 < 0.9922)", () => {
    const v = verdictText({ verdict: "keep", reason: BC_E003, metric: "roc_auc", candMean: 0.99174, prev: { id: "e000", mean: 0.99219 } });
    expect(v.newBest).toBe(false);
    expect(v.line).toBe("Kept — faster model, equally good (within noise)");
    expect(v.compare).toBe("0.9917 vs 0.9922 for e000 · −0.0005 (0.19 SE worse)");
    expect(isNewBest("keep", BC_E003)).toBe(false);
  });
  it("an improvement is a new best, with its p-value", () => {
    const v = verdictText({ verdict: "keep", reason: BC_E005, metric: "roc_auc", candMean: 0.99356, prev: { id: "e003", mean: 0.99174 } });
    expect(v.newBest).toBe(true);
    expect(v.line).toBe("Kept · new best — better and not luck (p = 0.02)");
    expect(v.compare).toBe("0.9936 vs 0.9917 for e003 · +0.0018 (0.72 SE better)");
  });
  it("a better average within noise is explained, in log-loss's own direction (penguins e001)", () => {
    const v = verdictText({ verdict: "discard", reason: PENGUINS_E001, metric: "log_loss", candMean: -0.03865, prev: { id: "e000", mean: -0.04918 } });
    expect(v.newBest).toBe(false);
    expect(v.line).toBe("Not kept — better on average but within noise (p = 0.41)");
    // log-loss went down by 0.0105: shown positive, lower is better, never negated
    expect(v.compare).toBe("0.0386 vs 0.0492 for e000 · −0.0105 (0.41 SE better)");
  });
  it("worse and equal scores say so", () => {
    expect(verdictText({ verdict: "discard", reason: BC_E016, metric: "roc_auc", prev: { id: "e012", mean: 0.99793 } }).line).toBe(
      "Not kept — worse than e012",
    );
    expect(verdictText({ verdict: "discard", reason: BC_E006, metric: "roc_auc", prev: { id: "e005", mean: 0.99356 } }).line).toBe(
      "Not kept — no better than e005",
    );
  });
  it("baseline, crashes and the other gate rules", () => {
    expect(verdictText({ verdict: "keep", reason: "baseline", metric: "roc_auc" })).toMatchObject({
      line: "Kept — the first score, the one to beat",
      newBest: false,
    });
    expect(verdictText({ verdict: "crash", reason: "runtime after 2 repair attempt(s)", metric: "roc_auc" }).line).toBe(
      "Broke — runtime error after 2 repairs",
    );
    expect(verdictText({ verdict: "discard", reason: "gain below 0.5 SE; gain 0.001 (+0.30 SE, SE=0.003), p=0.05", metric: "rmse" }).line).toBe(
      "Not kept — better, but by too little to count (0.30 SE; needs 0.5)",
    );
    expect(verdictText({ verdict: "keep", reason: "naive: cv mean improved by 0.01", metric: "rmse" })).toMatchObject({ newBest: true });
  });
});

describe("plainGateReason", () => {
  it("never shows an oriented (negated) number", () => {
    const t = plainGateReason(PENGUINS_E001, "discard", "log_loss");
    expect(t).toBe(
      "Not kept — better on average but within noise (p = 0.41). Change −0.0105 Log-loss (0.41 SE better), p = 0.41; held-out 0.0341 vs best 0.0030 (had to be at most 0.0287).",
    );
    expect(t).not.toMatch(/-0\.\d/);
  });
  it("names what made a simplification simpler", () => {
    expect(plainGateReason(BC_E003, "keep", "roc_auc")).toContain("fit time 0.09 s → 0.04 s");
  });
});

describe("chat: scores in their natural direction", () => {
  it("un-negates an older engine's executor line for log-loss", async () => {
    const { runItems } = await import("@/lib/chat");
    const ev = (seq: number, type: string, extra: Record<string, unknown>) => ({
      v: 1,
      seq,
      ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
      run_id: "r",
      type,
      ...extra,
    });
    const items = runItems({
      id: "r",
      events: [
        ev(0, "run_started", { profile: { metric: "log_loss", target: "species", n_rows: 344, n_cols: 7, columns: [] }, task: {}, config: {} }),
        ev(1, "agent_step_finished", {
          exp_id: "e000",
          step: { step_id: "s1", role: "executor", status: "ok", plain: "Ran in the sandbox: CV -0.0492 ± 0.0257" },
        }),
      ] as never,
    });
    const x = items.find((i) => i.kind === "experiment");
    expect(x && x.kind === "experiment" && x.steps[0].plain).toBe("Ran in the sandbox: CV 0.0492 ± 0.0257");
  });
});
