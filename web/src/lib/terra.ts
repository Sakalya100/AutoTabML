/**
 * Pure helpers for the run pages and the gallery around the survey world (docs/creative/02-direction.md).
 * No three.js and no React here, so everything is unit-tested in tests/terra.test.ts.
 */
import { formatScore, metricInfo } from "./metrics";
import type { RunView } from "./run-state";
import type { SurveyPose } from "./survey/contract";

/** A short camera "moment" played when the watcher sees the run change phase. */
export type SurveyMoment = "ceiling" | "truth" | null;

/** How long each moment holds before the camera returns to its resting pose (ms). */
export const MOMENT_MS: Record<Exclude<SurveyMoment, null>, number> = { ceiling: 5200, truth: 6000 };

/**
 * The moment a phase transition earns. Only transitions seen while watching count: a cold load of a finished
 * run goes straight to the overview, without replaying the stop and the test.
 */
export function momentFor(prev: RunView["phase"], next: RunView["phase"]): SurveyMoment {
  if (prev === next) return null;
  if (next === "stopped" && prev === "running") return "ceiling";
  if (next === "finished" && (prev === "running" || prev === "stopped")) return "truth";
  return null;
}

/** The camera pose for the run page: a playing moment wins, then "climb" while the run grows, else the overview. */
export function poseFor(opts: { moment: SurveyMoment; staging: boolean; phase: RunView["phase"] }): SurveyPose {
  if (opts.moment) return opts.moment;
  if (opts.staging && (opts.phase === "running" || opts.phase === "empty")) return "climb";
  return "overview";
}

/** Fitted ceiling (where the cloud deck settles): best mean + saturation value, or + SE; null before the stop. */
export function ceilingScore(view: RunView): number | null {
  if (view.phase !== "stopped" && view.phase !== "finished") return null;
  const best = view.experiments.find((x) => x.id === view.bestId);
  const bestMean = best?.cv?.mean ?? best?.bestMeanAfter ?? null;
  if (bestMean == null) return null;
  const sat = view.stop?.signals.find((s) => s.key === "saturation");
  if (typeof sat?.value === "number" && Number.isFinite(sat.value)) return bestMean + Math.max(0, sat.value);
  return bestMean + (best?.cv?.se ?? 0);
}

/** Screen-reader summary, e.g. "Survey of 37 probes, 4 kept, best ROC-AUC 0.9979, test 0.9950." */
export function surveySummary(view: RunView): string {
  const n = view.experiments.length;
  if (!n) return "Survey map: the run has not landed a probe yet.";
  const kept = view.experiments.filter((x) => x.status === "keep").length;
  const crashed = view.experiments.filter((x) => x.status === "crash").length;
  const best = view.experiments.find((x) => x.id === view.bestId);
  const parts = [`Survey of ${n} probe${n === 1 ? "" : "s"}`, `${kept} kept`];
  if (crashed) parts.push(`${crashed} crashed`);
  if (best?.cv) parts.push(`best ${metricInfo(view.metric).label} ${formatScore(view.metric, best.cv.mean)}`);
  if (view.phase === "stopped") parts.push("stopped under the ceiling, scoring the locked test");
  if (view.final) parts.push(`test ${formatScore(view.metric, view.final.testScore)}`);
  return parts.join(", ") + ". Every probe is also listed in the experiments ledger.";
}

/** Changed lines of a unified diff (the map projection's step length), without shipping the diff itself. */
export function diffSize(diff: string | undefined): number {
  if (!diff) return 0;
  let n = 0;
  for (const line of diff.split("\n")) {
    if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) n++;
  }
  return n;
}

/**
 * A RunView small enough to hand to a gallery card: no code, no error tails, no rationale, no profile rows.
 * The diff is replaced by a synthetic one with the same number of changed lines, so the map projection
 * (step length = size of the change) lays the probes out exactly as on the full run page.
 */
export function slimView(view: RunView): RunView {
  return {
    ...view,
    profile: null,
    experiments: view.experiments.map((x) => {
      const { code: _code, diff, ...rest } = x;
      void _code;
      const n = diffSize(diff);
      return {
        ...rest,
        idea: { ...x.idea, rationale: "" },
        reason: "",
        attempts: x.attempts.map((a) => ({ ...a, errorTail: null })),
        llmCalls: [],
        ...(diff != null ? { diff: n ? "+\n".repeat(n).slice(0, -1) : "" } : {}),
      };
    }),
    current: null,
  };
}
