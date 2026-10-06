import { LocalRunner } from "./local";
import type { Runner } from "./types";
import { VercelSandboxRunner } from "./vercel-sandbox";

export type { Runner, StartOptions } from "./types";

export type RunnerKind = Runner["kind"];

/** AUTOTABML_RUNNER=local|vercel-sandbox. Defaults to vercel-sandbox on Vercel, local elsewhere. */
export function runnerKind(): RunnerKind {
  const v = process.env.AUTOTABML_RUNNER;
  if (v === "local" || v === "vercel-sandbox") return v;
  return process.env.VERCEL ? "vercel-sandbox" : "local";
}

export function getRunner(kind: RunnerKind = runnerKind()): Runner {
  return kind === "vercel-sandbox" ? new VercelSandboxRunner() : new LocalRunner();
}

/** Live runs can be switched off entirely (replays-only demo) with AUTOTABML_LIVE_RUNS=0. */
export function liveRunsEnabled(): boolean {
  return process.env.AUTOTABML_LIVE_RUNS !== "0";
}

/** Engine --llm value for a UI choice. "anthropic:" (empty model) = the engine's default Anthropic model. */
export function llmSpec(choice: "heuristic" | "anthropic"): string {
  return choice === "heuristic" ? "heuristic" : process.env.AUTOTABML_ANTHROPIC_LLM_SPEC || "anthropic:";
}
