import type { RunMeta } from "../store/types";

export interface StartOptions {
  meta: RunMeta;
  /** Uploaded CSV (source "file"). Absent for link runs: the engine downloads `meta.sourceUrl` itself. */
  csv?: Buffer | null;
}

export interface Runner {
  readonly kind: RunMeta["runner"];
  /** Start the run. Resolves once it is launched (not when it finishes). Failures are recorded on the meta. */
  start(opts: StartOptions): Promise<void>;
  /** Stop a run. Returns false if there was nothing to stop. */
  cancel(meta: RunMeta): Promise<boolean>;
}

/**
 * The engine CLI arguments after `python`: the AGENTIC path,
 *   -m autotinker run <url|path> --target T [--metric M] [--goal G] --max-experiments N --out DIR --events-stdout
 * Shared by both runners so they run the same command. argv, not a shell string: nothing here is interpolated.
 */
export function engineArgs(o: { source: string; target: string; maxExperiments: number; outDir: string; metric?: string | null; goal?: string | null }): string[] {
  const args = ["-m", "autotinker", "run", o.source, "--target", o.target];
  if (o.metric) args.push("--metric", o.metric);
  if (o.goal && process.env.AUTOTINKER_PASS_DESCRIPTION !== "0") args.push("--goal", o.goal);
  args.push("--max-experiments", String(o.maxExperiments), "--out", o.outDir, "--events-stdout");
  return args;
}
