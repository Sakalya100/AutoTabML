/**
 * Metric orientation and display. Mirrors `Metric` in src/autotabml/contracts.py:
 * every stored score is *oriented* (higher is better); minimised metrics (log_loss, rmse, mae) are stored negated.
 * Never show an oriented number to a user — convert with `toRaw` first.
 */
import type { Metric } from "./schema";

export interface MetricInfo {
  id: Metric;
  label: string;
  greaterIsBetter: boolean;
  /** Decimal places that make sense for the raw value. */
  digits: number;
}

export const METRICS: Record<Metric, MetricInfo> = {
  roc_auc: { id: "roc_auc", label: "ROC-AUC", greaterIsBetter: true, digits: 4 },
  log_loss: { id: "log_loss", label: "Log-loss", greaterIsBetter: false, digits: 4 },
  accuracy: { id: "accuracy", label: "Accuracy", greaterIsBetter: true, digits: 4 },
  f1_macro: { id: "f1_macro", label: "Macro F1", greaterIsBetter: true, digits: 4 },
  rmse: { id: "rmse", label: "RMSE", greaterIsBetter: false, digits: 4 },
  mae: { id: "mae", label: "MAE", greaterIsBetter: false, digits: 4 },
  r2: { id: "r2", label: "R²", greaterIsBetter: true, digits: 4 },
};

export function metricInfo(m: Metric | string | null | undefined): MetricInfo {
  if (m && m in METRICS) return METRICS[m as Metric];
  return { id: (m ?? "accuracy") as Metric, label: m ?? "score", greaterIsBetter: true, digits: 4 };
}

export function greaterIsBetter(m: Metric | string | null | undefined): boolean {
  return metricInfo(m).greaterIsBetter;
}

/** Oriented (higher-is-better) → the metric's natural value. */
export function toRaw(m: Metric | string | null | undefined, oriented: number): number {
  const v = greaterIsBetter(m) ? oriented : -oriented;
  return Object.is(v, -0) ? 0 : v;
}

/** Natural value → oriented (higher-is-better). */
export function toOriented(m: Metric | string | null | undefined, raw: number): number {
  const v = greaterIsBetter(m) ? raw : -raw;
  return Object.is(v, -0) ? 0 : v;
}

/** "↓ lower is better" / "↑ higher is better". */
export function directionLabel(m: Metric | string | null | undefined): string {
  return greaterIsBetter(m) ? "↑ higher is better" : "↓ lower is better";
}

/**
 * Fixed decimals for small magnitudes; compact (1.196M, 62.32k) once |x| >= 10,000 so large-unit metrics
 * like RMSE on prices stay readable and fit chart gutters.
 */
export function fmtNum(x: number, digits = 4): string {
  if (!Number.isFinite(x)) return "—";
  if (Math.abs(x) >= 1e4) {
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 4 }).format(x);
  }
  return x.toFixed(digits);
}

/** Format an oriented score as the metric's raw value. */
export function formatScore(m: Metric | string | null | undefined, oriented: number | null | undefined, digits?: number): string {
  if (oriented == null || !Number.isFinite(oriented)) return "—";
  return fmtNum(toRaw(m, oriented), digits ?? metricInfo(m).digits);
}

/** Standard errors are magnitudes; orientation does not change them. */
export function formatSe(se: number | null | undefined, digits = 4): string {
  if (se == null || !Number.isFinite(se)) return "—";
  return fmtNum(se, digits);
}

export interface Delta {
  /** Raw-units change, sign in the metric's own direction (e.g. negative log-loss change = it went down). */
  raw: number;
  /** True if the change is an improvement (positive in oriented units). */
  better: boolean;
  text: string;
}

/**
 * Change from `fromOriented` to `toOriented`, expressed in raw metric units.
 * For log-loss 0.0812 → 0.0743 this is raw −0.0069, better = true.
 */
export function scoreDelta(
  m: Metric | string | null | undefined,
  fromOriented: number | null | undefined,
  toOrientedScore: number | null | undefined,
  digits?: number,
): Delta | null {
  if (fromOriented == null || toOrientedScore == null) return null;
  const orientedDiff = toOrientedScore - fromOriented;
  const raw = toRaw(m, toOrientedScore) - toRaw(m, fromOriented);
  const d = digits ?? metricInfo(m).digits;
  const sign = raw > 0 ? "+" : raw < 0 ? "−" : "±";
  return { raw, better: orientedDiff > 0, text: `${sign}${fmtNum(Math.abs(raw), d)}` };
}

/**
 * Optimism gap = select − test in oriented units (positive = the selection score was optimistic).
 * Magnitude is the same in raw units; we describe it in words so the sign is unambiguous for both directions.
 */
export function describeGap(m: Metric | string | null | undefined, gapOriented: number, digits?: number): string {
  const d = digits ?? metricInfo(m).digits;
  const mag = fmtNum(Math.abs(gapOriented), d);
  if (gapOriented > 0) return `test is ${mag} ${greaterIsBetter(m) ? "lower" : "higher"} than select — select was optimistic`;
  if (gapOriented < 0) return `test is ${mag} ${greaterIsBetter(m) ? "higher" : "lower"} than select — no optimism`;
  return "test matches select exactly";
}
