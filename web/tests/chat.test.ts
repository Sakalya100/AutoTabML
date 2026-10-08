import { describe, expect, it } from "vitest";
import { buildChat, experimentStage, runItems, type ChatExperiment, type ChatItem } from "@/lib/chat";
import type { AnyEvent } from "@/lib/events";

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 9, 8, 10, 0, s)).toISOString();
const e = (s: number, type: string, body: Record<string, unknown> = {}): AnyEvent => ({ run_id: "r-x", seq: ++seq, ts: at(s), type, ...body }) as unknown as AnyEvent;
const started = (s: number, step_id: string, role: string, exp_id: string | null, input_summary = "") => e(s, "agent_step_started", { step_id, role, exp_id, input_summary });
const finished = (s: number, step_id: string, role: string, exp_id: string | null, extra: Record<string, unknown> = {}) =>
  e(s, "agent_step_finished", { exp_id, step: { step_id, role, plain: `${role} done`, tokens_in: 10, tokens_out: 5, ...extra } });
const idea = (title: string, category = "model_family") => ({ title, category, rationale: "", radical: false });

function run(): AnyEvent[] {
  seq = 0;
  return [
    e(0, "run_started", { task: { target: "y" }, profile: { target: "y", n_rows: 100, n_cols: 5, metric: "roc_auc", problem_type: "binary", columns: [] }, config: { stop_rule: { max_experiments: 4 } }, proposer: "agentic" }),
    started(1, "s1", "intake", null),
    finished(2, "s1", "intake", null),
    started(3, "s2", "profiler", null),
    finished(4, "s2", "profiler", null),
    e(5, "experiment_started", { exp_id: "e000", parent_id: null, idea: idea("Baseline", "baseline"), phase: "baseline" }),
    e(6, "decision", { exp_id: "e000", decision: "keep", reason: "baseline", best_exp_id: "e000", best_cv_mean: 0.7 }),
    // the planner and coder of e001 run before its experiment_started
    started(7, "s3", "planner", "e001", "draft: 1 done"),
    finished(8, "s3", "planner", "e001", { reasoning: "think" }),
    e(9, "steer_applied", { text: "prefer simple linear models", at_exp: "e002" }),
    started(10, "s4", "coder", "e001"),
    finished(11, "s4", "coder", "e001", { code: "x = 1", diff: "+x = 1" }),
    e(12, "experiment_started", { exp_id: "e001", parent_id: null, idea: idea("Random forest"), phase: "draft" }),
    e(13, "experiment_scored", { exp_id: "e001", cv: { mean: 0.8, se: 0.01 }, select_score: 0.79 }),
    e(14, "decision", { exp_id: "e001", decision: "keep", reason: "improvement: p=0.01 gain 0.1 (+2.10 SE, SE=0.01)", best_exp_id: "e001", best_cv_mean: 0.8 }),
    started(15, "s5", "tuner", "e002"),
    e(16, "experiment_started", { exp_id: "e002", parent_id: "e001", idea: idea("Tune RF", "hyperparameters") }), // no phase: inferred
    e(17, "decision", { exp_id: "e002", decision: "discard", reason: "not significant: p=0.4", best_exp_id: "e001", best_cv_mean: 0.8 }),
    e(18, "stopped", { reason: "user", summary: "stopped by the user after e002", report: {} }),
    e(19, "run_finished", { best_exp_id: "e001", dev_cv_mean: 0.8, select_score: 0.79, test_score: 0.78, optimism_gap: 0.01, n_experiments: 3, total_cost_usd: 0, wall_time_s: 60 }),
    started(20, "s6", "reporter", null),
    finished(21, "s6", "reporter", null),
    e(22, "report_ready", { report: { plain: "Found it.", summary: "sum", what_worked: ["rf"], caveats: [], next_steps: [], notes: ["User asked: prefer simple linear models"] } }),
  ];
}

const kinds = (xs: ChatItem[]) => xs.map((x) => (x.kind === "divider" ? `|${x.stage}` : x.kind));

describe("chat reducer", () => {
  it("groups steps per experiment, with stage dividers in run order", () => {
    const items = runItems({ id: "r-x", events: run(), status: "finished" });
    expect(kinds(items)).toEqual([
      "|intake", "task", "step", // intake
      "|profiling", "step",
      "|baseline", "experiment",
      "|drafts", "experiment", "steer_ack",
      "|tuning", "experiment",
      "|stop", "stopped",
      "|locked_test", "final",
      "|report", "report", // the finished reporter step is folded into the report
    ]);
    const e001 = items.find((x): x is ChatExperiment => x.kind === "experiment" && x.id === "e001")!;
    expect(e001.steps.map((s) => s.role)).toEqual(["planner", "coder"]); // held from before experiment_started
    expect(e001.steps[0].reasoning).toBe("think");
    expect(e001.steps[1]).toMatchObject({ code: "x = 1", diff: "+x = 1", tokensIn: 10, status: "ok" });
    expect(e001.idea?.title).toBe("Random forest");
    expect(e001.decision).toMatchObject({ verdict: "keep", newBest: true, gate: { p: 0.01, gainSe: 2.1 } });
    const ack = items.find((x) => x.kind === "steer_ack");
    expect(ack).toMatchObject({ text: "prefer simple linear models", atExp: "e002" });
  });

  it("shows a running step and an experiment before its idea is known", () => {
    const evs = run().slice(0, 8); // through planner started
    const items = runItems({ id: "r-x", events: evs });
    const x = items.find((i): i is ChatExperiment => i.kind === "experiment" && i.id === "e001")!;
    expect(x.idea).toBeNull();
    expect(x.steps[0]).toMatchObject({ role: "planner", status: "running" });
    expect(x.stage).toBe("drafts"); // from the planner's input summary
  });

  it("infers stages for engines that don't send a phase", () => {
    const base = { index: 3, idea: null, steps: [] };
    expect(experimentStage({ ...base, steps: [{ role: "ensembler" } as never] })).toBe("ensemble");
    expect(experimentStage({ ...base, index: 0 })).toBe("baseline");
    expect(experimentStage({ ...base, steps: [{ role: "planner", inputSummary: "improve: 4 done" } as never] })).toBe("improve");
  });

  it("merges stored messages by time and closes failed/cancelled runs", () => {
    const evs = run().slice(0, 12);
    const items = buildChat(
      [{ id: "r-x", events: evs, status: "cancelled", error: "Cancelled by user." }],
      [
        { id: "m1", role: "user", text: "Predict y", kind: "chat", created_at: at(-1) },
        { id: "m2", role: "user", text: "prefer simple linear models", kind: "steer", created_at: at(8.5) },
      ],
    );
    const k = kinds(items);
    expect(k[0]).toBe("user"); // the run sentence comes first
    const steerAt = items.findIndex((x) => x.kind === "user" && x.msgKind === "steer");
    const ackAt = items.findIndex((x) => x.kind === "steer_ack");
    expect(steerAt).toBeGreaterThan(0);
    expect(steerAt).toBeLessThan(ackAt); // the user's steer, then the engine's acknowledgement
    expect(items.at(-1)).toMatchObject({ kind: "run_end", status: "cancelled" });
  });
});
