/**
 * Setup guard-rails for a new run: which columns can't be learned as a target (blocked, with a short reason), the
 * non-blocking warnings shown under the fields, and a time estimate before Start. Isomorphic.
 * The blocking rules are mirrored server-side in backend/autotinker_api/validation.py (`target_block`).
 */
import type { ColumnStats } from "./csv";

/** A target with more than this share of empty cells is blocked; above WARN_MISSING it is a warning. */
export const MAX_TARGET_MISSING = 0.5;
export const WARN_MISSING = 0.1;
export const SMALL_TABLE_ROWS = 100;
export const MANY_CLASSES = 50;
export const RARE_CLASS = 0.05;

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Why `c` can't be the column to predict, or null if it can. */
export function targetBlock(c: ColumnStats | undefined): string | null {
  if (!c) return null;
  const total = c.count + c.missing;
  if (c.kind === "empty" || c.count === 0) return "Empty — no values to learn from";
  if (c.kind === "id") return "ID column — every row is different";
  if (total > 0 && c.missing / total > MAX_TARGET_MISSING) return `Mostly missing — ${pct(c.missing / total)} of rows are empty`;
  if (c.kind === "text") return "Free text — almost every value is different";
  if (c.unique < 2) return "Constant — the same value in every row";
  return null;
}

export type ProblemKind = "binary" | "multiclass" | "regression";

/** Non-blocking warnings for the chosen setup, in plain words. */
export function setupWarnings(stats: ColumnStats[], target: string, rows: number | null, problemType: ProblemKind): string[] {
  const out: string[] = [];
  const c = stats.find((s) => s.name === target);
  const n = rows ?? (c ? c.count + c.missing : null);
  if (n != null && n < SMALL_TABLE_ROWS) out.push(`Very small table (${n} rows): scores will be noisy; try fewer experiments.`);
  if (!c) return out;
  if (problemType !== "regression") {
    if (c.unique > MANY_CLASSES) out.push(`${c.unique} classes to tell apart: that is a lot; some will have very few examples.`);
    if (c.minCount != null && c.count > 0 && c.minCount / c.count < RARE_CLASS)
      out.push(
        `Imbalanced: the rarest class is ${(100 * (c.minCount / c.count)).toFixed(1)}% of rows (${c.minCount}); accuracy can look good while missing it.`,
      );
  }
  const total = c.count + c.missing;
  if (total > 0 && c.missing / total > WARN_MISSING) out.push(`${pct(c.missing / total)} of ${target} is empty; those rows can't be used for training.`);
  return out;
}

/**
 * Wall-clock estimate in seconds for a run: T = A + n · (B + C · rows · cols), fitted to real runs (sandbox start
 * included): Titanic 891×12, 2 experiments ≈ 65 s and 10 ≈ 300 s; iris 150×5, 5 experiments ≈ 66 s.
 */
export const EST = { A: 6, B: 10.6, C: 0.00175 } as const;

export function estimateSeconds(rows: number, cols: number, experiments: number): number {
  const cells = Math.max(0, rows) * Math.max(1, cols);
  return EST.A + Math.max(1, experiments) * (EST.B + EST.C * cells);
}

/** "≈ 3–6 min for 10 experiments" (a 0.8×–1.25× band around the estimate, whole minutes). */
export function estimateText(rows: number | null, cols: number, experiments: number): string | null {
  if (rows == null || rows <= 0) return null;
  const t = estimateSeconds(rows, cols, experiments);
  const lo = Math.max(1, Math.floor((0.8 * t) / 60));
  const hi = Math.max(lo + 1, Math.ceil((1.25 * t) / 60));
  return `≈ ${lo}–${hi} min for ${experiments} experiment${experiments === 1 ? "" : "s"}`;
}

/**
 * Live ETA from the pace so far: (time from the first experiment's start to the last decision) / decisions, times the
 * experiments left, minus the time already spent on the one in flight. Null until one experiment has finished.
 */
export function liveEtaSeconds(firstStartMs: number | null, decisionMs: readonly number[], planned: number | null, nowMs: number): number | null {
  const done = decisionMs.length;
  if (firstStartMs == null || !planned || done < 1) return null;
  const last = Math.max(...decisionMs);
  const pace = (last - firstStartMs) / 1000 / done;
  if (!(pace > 0)) return null;
  const left = Math.max(0, planned - done);
  if (left === 0) return 0;
  return Math.max(0, pace * left - Math.max(0, (nowMs - last) / 1000));
}

/** "≈ 4 min left", "< 1 min left". */
export function etaText(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return seconds <= 0 ? null : "< 1 min left";
  return `≈ ${Math.round(seconds / 60)} min left`;
}
