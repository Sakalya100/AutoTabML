/**
 * Deterministic suggestions for a new run: which column to predict, the problem type and the metric.
 * The problem-type rule mirrors `infer_problem_type` in src/autotinker/data/profiler.py, and the metric
 * defaults and valid sets mirror DEFAULT_METRIC / _VALID_METRICS there. Isomorphic.
 */
import type { ColumnStats } from "./csv";
import { targetBlock } from "./guards";

export type ProblemType = "binary" | "multiclass" | "regression";
export type MetricId = "roc_auc" | "log_loss" | "accuracy" | "f1_macro" | "rmse" | "mae" | "r2";

export const PROBLEM_TYPES: readonly ProblemType[] = ["binary", "multiclass", "regression"];
export const METRICS: readonly MetricId[] = ["roc_auc", "log_loss", "accuracy", "f1_macro", "rmse", "mae", "r2"];
export const DEFAULT_METRIC: Record<ProblemType, MetricId> = { binary: "roc_auc", multiclass: "log_loss", regression: "rmse" };
export const VALID_METRICS: Record<ProblemType, readonly MetricId[]> = {
  binary: ["roc_auc", "log_loss", "accuracy", "f1_macro"],
  multiclass: ["log_loss", "accuracy", "f1_macro"],
  regression: ["rmse", "mae", "r2"],
};
export const METRIC_LABEL: Record<MetricId, string> = {
  roc_auc: "ROC-AUC",
  log_loss: "log-loss",
  accuracy: "accuracy",
  f1_macro: "F1 (macro)",
  rmse: "RMSE",
  mae: "MAE",
  r2: "R²",
};
export const PROBLEM_LABEL: Record<ProblemType, string> = { binary: "yes / no", multiclass: "one of several classes", regression: "a number" };

const CLASSIFICATION_MAX_UNIQUE = 20;
const CLASSIFICATION_MAX_RATIO = 0.05;

export interface Suggestion {
  target: string;
  problemType: ProblemType;
  metric: MetricId;
  /** One plain sentence: what the run will learn to do. */
  goalPlain: string;
  /** Why this target/metric, in a few words. */
  why: string;
  source: "heuristic" | "llm";
  /** No column name looked like a target, or two columns were close: worth asking the LLM / the user. */
  ambiguous: boolean;
}

/** Column names that are, on their own, a strong hint "this is the thing to predict". */
const STRONG = new Set([
  "target",
  "label",
  "labels",
  "class",
  "y",
  "outcome",
  "survived",
  "churn",
  "churned",
  "exited",
  "attrition",
  "diagnosis",
  "price",
  "saleprice",
  "species",
  "variety",
  "quality",
  "default",
  "fraud",
  "isfraud",
  "income",
  "medv",
  "charges",
  "response",
  "result",
  "outcome_type",
  "deposit",
  "approved",
  "loan_status",
  "heartdisease",
  "disease",
  "stroke",
  "diabetes",
  "malignant",
  "category",
  "rating",
  "score",
  "salary",
  "sales",
  "revenue",
  "cost",
  "value",
  "medhouseval",
]);
const WEAK_TOKENS = /(target|label|class|outcome|churn|surviv|diagnos|price|default|fraud|status|result|grade)/;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

/** The engine's problem type for a column, from its profile. Null if the column can't be a target. */
export function inferProblemType(c: ColumnStats, nRows: number): ProblemType | null {
  if (c.unique < 2 || c.kind === "empty") return null;
  if (c.kind === "numeric") return "regression";
  if (c.kind === "integer" || c.kind === "id") {
    if (c.unique === 2) return "binary";
    if (c.unique <= CLASSIFICATION_MAX_UNIQUE && c.unique / Math.max(nRows, 1) <= CLASSIFICATION_MAX_RATIO) return "multiclass";
    return "regression";
  }
  if (c.kind === "boolean") return "binary";
  return c.unique === 2 ? "binary" : "multiclass";
}

export function scoreTargets(stats: ColumnStats[], goal = ""): { name: string; score: number; why: string }[] {
  const goalWords = new Set(words(goal));
  const goalNorm = norm(goal);
  const nRows = Math.max(...stats.map((s) => s.count + s.missing), 1);
  return stats.map((c, i) => {
    let score = 0;
    let why = "";
    const n = norm(c.name);
    const cw = words(c.name);
    if (
      goal &&
      n.length >= 2 &&
      (goalNorm.includes(n) || (cw.length > 0 && cw.every((w) => goalWords.has(w) || goalWords.has(w + "s") || goalWords.has(w.replace(/s$/, "")))))
    ) {
      score += 20; // the user's own words beat any naming convention
      why = "named in your sentence";
    }
    if (STRONG.has(n)) {
      score += 10;
      why ||= "named like a prediction target";
    } else if (WEAK_TOKENS.test(c.name.toLowerCase())) {
      score += 6;
      why ||= "named like a prediction target";
    }
    if (i === stats.length - 1) {
      score += 3;
      why ||= "the last column, where targets usually sit";
    }
    if (i === 0) score -= 2;
    if (c.kind === "id") score -= 20;
    if (c.kind === "datetime" || c.kind === "empty") score -= 12;
    if (c.kind === "text") score -= 6;
    if (c.kind === "categorical" && c.unique > 50) score -= 4;
    if (c.unique >= 2 && c.unique <= 20) score += 1;
    if (c.missing > 0.3 * nRows) score -= 3;
    if (inferProblemType(c, nRows) === null) score -= 30;
    return { name: c.name, score, why: why || "the most plausible column left" };
  });
}

function goalSentence(target: string, ptype: ProblemType, c: ColumnStats | undefined): string {
  if (ptype === "binary") return `Predict ${target} (one of two outcomes) for each row.`;
  if (ptype === "multiclass") return `Predict which ${target} each row belongs to${c ? ` (${c.unique} classes)` : ""}.`;
  return `Predict the value of ${target} for each row.`;
}

/** Build the suggestion for a specific target column (used when the user picks a different target). */
export function suggestionFor(stats: ColumnStats[], target: string, why: string, ambiguous = false): Suggestion {
  const nRows = Math.max(...stats.map((s) => s.count + s.missing), 1);
  const c = stats.find((s) => s.name === target);
  const problemType = (c && inferProblemType(c, nRows)) || "regression";
  const metric = DEFAULT_METRIC[problemType];
  const metricWhy = {
    binary: "ROC-AUC ranks yes/no predictions fairly even when one outcome is rare",
    multiclass: "log-loss rewards confident, correct class probabilities",
    regression: "RMSE is in the target's own units",
  }[problemType];
  return {
    target,
    problemType,
    metric,
    goalPlain: goalSentence(target, problemType, c),
    why: `${target}: ${why}; ${metricWhy}.`,
    source: "heuristic",
    ambiguous,
  };
}

/** Pick the most likely target column (never a blocked one) and derive the problem type and metric. */
export function suggest(stats: ColumnStats[], goal = ""): Suggestion | null {
  if (stats.length < 2) return null;
  // Columns that can't be learned (IDs, free text, constant, mostly empty) are never suggested.
  const blocked = new Set(stats.filter((c) => targetBlock(c)).map((c) => c.name));
  const ranked = scoreTargets(stats, goal)
    .filter((r) => !blocked.has(r.name))
    .sort((a, b) => b.score - a.score);
  const [top, second] = ranked;
  if (!top || top.score < -10) return null;
  const ambiguous = top.score < 6 || (second !== undefined && top.score - second.score <= 2);
  return suggestionFor(stats, top.name, top.why, ambiguous);
}

/** True if `metric` is a metric the engine accepts for `ptype`. */
export function metricFits(ptype: ProblemType, metric: string): metric is MetricId {
  return (VALID_METRICS[ptype] as readonly string[]).includes(metric);
}

/** `sug` if its target can be learned; otherwise the best allowed column (an LLM/server pick can land on an ID). */
export function allowedSuggestion(stats: ColumnStats[], sug: Suggestion | null, goal = ""): Suggestion | null {
  if (sug && !targetBlock(stats.find((c) => c.name === sug.target))) return sug;
  return suggest(stats, goal);
}
