import type { RunMeta } from "../store/types";

export interface StartOptions {
  meta: RunMeta;
  csv: Buffer;
  /** The engine's --llm value, e.g. "heuristic" or "anthropic". */
  llmSpec: string;
  /**
   * BYOK key for this run only. Runners must pass it to the engine's environment (local) or broker it at the
   * network edge (vercel-sandbox), and must never write it to the store, to disk, or to logs.
   */
  apiKey?: string | null;
}

export interface Runner {
  readonly kind: RunMeta["runner"];
  /** Start the run. Resolves once it is launched (not when it finishes). Failures are recorded on the meta. */
  start(opts: StartOptions): Promise<void>;
  /** Stop a run. Returns false if there was nothing to stop. */
  cancel(meta: RunMeta): Promise<boolean>;
}

/** The engine CLI arguments after `python`. Shared by both runners so they run the same command. */
export function engineArgs(o: { csvPath: string; target: string; llmSpec: string; maxExperiments: number; outDir: string; description?: string }): string[] {
  const args = ["-m", "autotabml", "evolve", o.csvPath, "--target", o.target, "--llm", o.llmSpec, "--max-experiments", String(o.maxExperiments), "--out", o.outDir, "--max-cost", process.env.AUTOTABML_MAX_COST_USD || "1", "--events-stdout"];
  if (o.description && process.env.AUTOTABML_PASS_DESCRIPTION !== "0") args.push("--description", o.description);
  return args;
}
