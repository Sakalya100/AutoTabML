export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtInt(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

export function fmtValue(v: unknown, digits = 4): string {
  if (v == null) return "n/a";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(digits);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

export const CATEGORY_LABEL: Record<string, string> = {
  baseline: "baseline",
  preprocessing: "preprocessing",
  feature_engineering: "features",
  model_family: "model family",
  hyperparameters: "hyperparameters",
  ensembling: "ensembling",
  simplification: "simplification",
  repair: "repair",
};

export const SIGNAL_LABEL: Record<string, { title: string; blurb: string }> = {
  noise_floor: { title: "Noise floor", blurb: "Recent kept gains are smaller than the best score's CV standard error." },
  saturation: { title: "Saturation fit", blurb: "A fitted a − b·e^(−ct) curve predicts less remaining gain than the noise floor." },
  exploration: { title: "Exploration exhausted", blurb: "Enough radical attempts since the last keep have all failed the gate." },
  external_ref: { title: "External reference", blurb: "Within ε of a known ceiling (AutoGluon best-quality, a leaderboard)." },
};

export const STOP_REASON_LABEL: Record<string, string> = {
  ceiling: "Reached the ceiling",
  max_experiments: "Hit the experiment budget",
  max_cost: "Hit the cost budget",
  max_time: "Hit the time budget",
  user: "Stopped by the user",
};
