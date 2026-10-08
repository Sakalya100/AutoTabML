import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coerceEvent, parseEventsJsonl } from "@/lib/events";
import { activeAgentStep, buildFeed, feedSignature, MAX_LOG_LINES, roleDoing, type AgentStepItem, type ExperimentItem, type ReportItem } from "@/lib/feed";
import { buildView } from "@/lib/run-state";

const text = readFileSync(path.join(__dirname, "../scripts/fixtures/agentic-breastcancer.events.jsonl"), "utf8");
const events = parseEventsJsonl(text);
const base = { run_id: "r-x", ts: "2026-01-01T00:00:00Z" };

const samples: Record<string, Record<string, unknown>> = {
  agent_step_started: { exp_id: "e001", step_id: "s1", role: "planner", attempt: 0, input_summary: "profile" },
  agent_reasoning: { exp_id: "e001", step_id: "s1", role: "planner", text: "thinking" },
  agent_step_finished: { exp_id: "e001", step: { step_id: "s1", role: "planner", plain: "try a forest" } },
  sandbox_log: { exp_id: "e001", attempt: 0, stream: "stdout", lines: ["fold 1 ok"] },
  hpo_trial: { exp_id: "e001", trial: { number: 0, params: { C: 1 }, value: 0.9 } },
  report_ready: { report: { plain: "done", summary: "it worked" } },
};

describe("agentic events parse", () => {
  for (const [type, body] of Object.entries(samples)) {
    it(`accepts ${type} and rejects it with a required field missing`, () => {
      const ok = coerceEvent({ ...base, seq: 5, type, ...body });
      expect(ok?.type).toBe(type);
      const key = Object.keys(body).find((k) => k !== "exp_id" && k !== "attempt" && k !== "stream" && k !== "input_summary")!;
      const partial: Record<string, unknown> = { ...base, seq: 5, type, ...body };
      delete partial[key];
      expect(coerceEvent(partial)).toBeNull();
    });
  }
  it("rejects malformed payloads", () => {
    expect(coerceEvent({ ...base, seq: 1, type: "agent_step_finished", exp_id: null, step: "nope" })).toBeNull();
    expect(coerceEvent({ ...base, seq: 1, type: "sandbox_log", exp_id: "e1", lines: "x" })).toBeNull();
    expect(coerceEvent({ ...base, seq: 1, type: "report_ready", report: null })).toBeNull();
  });
  it("parses every line of a real agentic run", () => {
    expect(text.trim().split("\n")).toHaveLength(199);
    expect(events).toHaveLength(199);
  });
});

describe("buildView on a real agentic run", () => {
  const v = buildView(events);
  it("still grows the world from experiment events and finishes", () => {
    expect(v.phase).toBe("finished");
    expect(v.experiments).toHaveLength(10);
    expect(v.experiments.every((x) => x.status !== "running")).toBe(true);
    expect(v.final?.nExperiments).toBe(10);
  });
  it("attaches steps (incl. planner/coder sent before experiment_started) and the report", () => {
    expect(v.runSteps.map((s) => s.role)).toEqual(expect.arrayContaining(["intake", "profiler"]));
    const e1 = v.experiments.find((x) => x.id === "e001")!;
    expect(e1.steps.map((s) => s.role).slice(0, 4)).toEqual(["planner", "coder", "executor", "critic"]);
    expect(e1.steps.every((s) => s.status !== "running" && s.plain)).toBe(true);
    expect(v.experiments.reduce((a, x) => a + x.hpoTrials, 0)).toBe(18);
    expect(v.report?.summary).toBeTruthy();
  });
});

describe("buildFeed on a real agentic run", () => {
  const items = buildFeed(events);
  const exps = items.filter((i): i is ExperimentItem => i.kind === "experiment");
  const runSteps = items.filter((i): i is AgentStepItem => i.kind === "agent_step");
  it("has run-level intake/profiler lines, 10 experiments with their steps, and the report", () => {
    expect(items[0].kind).toBe("run_started");
    expect(runSteps.slice(0, 2).map((s) => s.role)).toEqual(["intake", "profiler"]);
    expect(runSteps.every((s) => !s.running && s.plain)).toBe(true);
    expect(exps).toHaveLength(10);
    expect(exps[1].steps[0].role).toBe("planner");
    expect(exps.every((x) => x.steps.length > 0 && x.steps.every((s) => !s.running))).toBe(true);
    const report = items.find((i): i is ReportItem => i.kind === "report");
    expect(report?.plain).toBeTruthy();
    expect(report?.whatWorked.length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
  it("a running step shows as running mid-stream and is named by activeAgentStep", () => {
    const cut = events.findIndex((e) => e.type === "agent_step_started" && e.exp_id === "e002");
    const prefix = events.slice(0, cut + 1);
    expect(activeAgentStep(prefix)).toEqual({ role: "planner", expId: "e002" });
    expect(roleDoing("planner")).toBe("Planner is choosing the next idea");
    expect(activeAgentStep(events)).toBeNull();
    const critic = events.findIndex((e) => e.type === "agent_step_started" && e.exp_id === "e001" && (e as { role?: string }).role === "critic");
    const mid = buildFeed(events.slice(0, critic + 1));
    const e1 = mid.filter((i): i is ExperimentItem => i.kind === "experiment").at(-1)!;
    expect(e1.steps.at(-1)).toMatchObject({ role: "critic", running: true });
    expect(feedSignature(mid)).not.toBe(feedSignature(buildFeed(events.slice(0, critic))));
  });
  it("collects sandbox logs (capped) on their experiment", () => {
    const start = events.find((e) => e.type === "experiment_started")!;
    const log = (seq: number, lines: string[]) => coerceEvent({ ...base, seq, type: "sandbox_log", exp_id: "e000", lines })!;
    const evs = [...events.slice(0, events.indexOf(start) + 1), log(1000, ["a", "b"]), log(1001, Array.from({ length: 300 }, (_, i) => `l${i}`))];
    const x = buildFeed(evs).find((i): i is ExperimentItem => i.kind === "experiment")!;
    expect(x.logs).toHaveLength(MAX_LOG_LINES);
    expect(x.logs.at(-1)).toBe("l299");
  });
});
