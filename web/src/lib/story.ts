/**
 * Plain-language story of a run, for the replay gallery, the replay page and the run feed.
 * Pure (no React, no three.js) and unit-tested in tests/story.test.ts. Everything is derived from recorded fields:
 * the problem type, row/column counts, the idea's title and category, and the gate's own reason. Nothing is invented —
 * where a field is missing the sentence is left out, and unknown idea titles are shown as written.
 */
import { parseGateReason } from "./feed";
import { fmtNum, formatScore, metricInfo, toRaw } from "./metrics";
import type { ExpView, RunView } from "./run-state";
import type { Idea, Metric } from "./schema";

/** "breast_cancer" → "Breast cancer". */
export function humanName(name: string): string {
  const s = name.replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : name;
}

/** What the run was asked to do, in words: "yes or no", "one of 3 kinds", "a number". */
export function answerKind(problemType: string | null | undefined, nClasses?: number | null): string | null {
  if (problemType === "binary") return "yes or no";
  if (problemType === "multiclass") return nClasses && nClasses > 2 ? `one of ${nClasses} kinds` : "one of several kinds";
  if (problemType === "regression") return "a number";
  return null;
}

export interface Asked {
  target: string | null;
  kind: string | null;
  rows: number | null;
  /** Feature columns (the target excluded). */
  features: number | null;
}

/** The task as recorded: target column, answer kind, rows and feature columns. */
export function askedOf(view: RunView): Asked {
  const p = view.profile;
  const target = p?.target ?? view.task?.target ?? null;
  const ts = (p as { target_summary?: { n_classes?: number | null } } | null)?.target_summary;
  const nClasses = ts?.n_classes ?? (p?.problem_type === "multiclass" ? classesFromColumns(view) : null);
  return {
    target,
    kind: answerKind(p?.problem_type ?? view.task?.problem_type, nClasses),
    rows: p?.n_rows ?? null,
    features: p?.n_cols != null ? Math.max(0, p.n_cols - 1) : null,
  };
}

function classesFromColumns(view: RunView): number | null {
  const p = view.profile;
  const col = p?.columns?.find((c) => c.name === p.target);
  return col?.n_unique ?? null;
}

/** "Stopped on its own" only when the ceiling rule fired; budgets and users say so. */
export function stopPhrase(reason: string | null | undefined, maxExperiments?: number | null): string | null {
  switch (reason) {
    case null:
    case undefined:
    case "":
      return null;
    case "ceiling":
      return "stopped on its own";
    case "max_experiments":
      return maxExperiments ? `stopped at its budget of ${maxExperiments} ideas` : "stopped at its idea budget";
    case "max_cost":
      return "stopped at its cost budget";
    case "max_time":
      return "stopped at its time budget";
    case "user":
      return "stopped by hand";
    default:
      return `stopped (${reason.replace(/_/g, " ")})`;
  }
}

export interface Outcome {
  tried: number;
  kept: number;
  crashed: number;
  stop: string | null;
}

export function outcomeOf(view: RunView): Outcome {
  const decided = view.experiments.filter((x) => x.status !== "running");
  const cfg = view.config as { max_experiments?: unknown; stop_rule?: { max_experiments?: unknown } };
  const max = cfg.max_experiments ?? cfg.stop_rule?.max_experiments;
  return {
    tried: decided.length,
    kept: decided.filter((x) => x.status === "keep").length,
    crashed: decided.filter((x) => x.status === "crash").length,
    stop: stopPhrase(view.stop?.reason, typeof max === "number" ? max : null),
  };
}

/** "37 ideas tried, 4 kept, stopped on its own". */
export function outcomeLine(o: Outcome): string {
  const parts = [`${o.tried} idea${o.tried === 1 ? "" : "s"} tried`, `${o.kept} kept`];
  if (o.stop) parts.push(o.stop);
  return parts.join(", ");
}

/**
 * The optimism gap in plain words. `gap` is select − test in oriented units (positive = it rated itself too high);
 * `se` is the best's CV standard error, the run's own yardstick for "within chance".
 */
export function plainGap(metric: Metric | string | null | undefined, gap: number, se: number | null | undefined): string {
  const d = metricInfo(metric).digits;
  const mag = fmtNum(Math.abs(gap), d);
  const small = se != null && se > 0 ? Math.abs(gap) <= 2 * se : Math.abs(gap) < 10 ** -(d - 1);
  if (gap === 0) return "Exactly what it expected from its own checks.";
  if (gap < 0) return `${mag} better than its own checks predicted, so it didn't fool itself.`;
  if (small) return `${mag} worse than its own estimate, within the normal wobble, so it didn't fool itself.`;
  return `${mag} worse than its own estimate: it rated itself a little too high.`;
}

/* ---- one idea, in words ---- */

const MODEL: Record<string, string> = {
  "linear model": "a linear model",
  logisticregression: "a linear model",
  linearregression: "a linear model",
  ridge: "a linear model",
  randomforest: "a random forest",
  extratrees: "extra trees",
  gradientboosting: "gradient boosting",
  histgradientboosting: "gradient boosting",
  xgboost: "XGBoost",
  lightgbm: "LightGBM",
  catboost: "CatBoost",
  knn: "nearest neighbours",
  kneighbors: "nearest neighbours",
  svm: "a support-vector machine",
  svc: "a support-vector machine",
};
const modelName = (s: string) => MODEL[s.trim().toLowerCase()] ?? s.trim();

const PARAM: Record<string, string> = {
  learning_rate: "learning rate",
  l2_regularization: "regularisation",
  max_depth: "tree depth",
  min_samples_leaf: "leaf size",
  max_iter: "number of rounds",
  n_estimators: "number of trees",
  c: "regularisation strength",
  max_leaf_nodes: "leaves per tree",
};

const lc = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const arrow = (s: string) => s.replace(/\s*->\s*/g, " → ");

/**
 * The idea as a short plain phrase that completes "Tried: …". Known engine titles are rewritten; anything else
 * (an LLM's free-text title) is shown as written.
 */
export function plainIdea(idea: Pick<Idea, "title" | "category">): string {
  const t = idea.title.trim();
  let m: RegExpExecArray | null;
  if (idea.category === "baseline" || /^baseline\b/i.test(t)) return "a simple starting model";
  if ((m = /^switch model family:\s*(.+?)\s*->\s*(.+)$/i.exec(t))) return `switching to ${modelName(m[2])}`;
  if ((m = /^(.+?):\s*set\s+([\w.]+)\s+(\S+)\s*->\s*(\S+)$/i.exec(t))) {
    const p = PARAM[m[2].toLowerCase()] ?? m[2].replace(/_/g, " ");
    const a = Number(m[3]);
    const b = Number(m[4]);
    const verb = Number.isFinite(a) && Number.isFinite(b) && a !== b ? (b > a ? "raising" : "lowering") : "changing";
    return `${verb} the ${p} (${m[3]} → ${m[4]})`;
  }
  if ((m = /^random\s+(.+?)\s+configuration\b/i.exec(t))) return `a random ${modelName(m[1]).replace(/^an? /, "")} setup`;
  if (/^soft-voting ensemble/i.test(t)) return "averaging the best models so far";
  if (/^stacking ensemble/i.test(t)) return "stacking the best models so far";
  if ((m = /^feature engineering:\s*(.+)$/i.exec(t))) return `new features: ${lc(arrow(m[1]))}`;
  if ((m = /^simplify:\s*(.+)$/i.exec(t))) return `simplifying: ${lc(arrow(m[1]))}`;
  if ((m = /^numeric scaling:\s*(.+)$/i.exec(t))) return `a different number scaling (${arrow(m[1])})`;
  return lc(arrow(t));
}

/* ---- the gate's verdict, in words ---- */

export type Tone = "kept" | "dropped" | "broke" | "running";

export interface Verdict {
  tone: Tone;
  /** "Better by a clear margin", "No better", … */
  text: string;
  /** "kept" / "dropped" / "crashed" / "testing…" */
  outcome: string;
}

/** What happened to one experiment, from its status and the gate's recorded reason. */
export function plainVerdict(x: Pick<ExpView, "status" | "reason" | "index">): Verdict {
  if (x.status === "running") return { tone: "running", text: "Being tested now", outcome: "testing…" };
  if (x.status === "crash") return { tone: "broke", text: "The code failed to run", outcome: "dropped" };
  const g = parseGateReason(x.reason);
  const se = g.gainSe;
  if (x.status === "keep") {
    if (g.label === "baseline" || (x.index === 0 && !g.label)) return { tone: "kept", text: "The starting point", outcome: "kept" };
    if (g.label === "simplification") return { tone: "kept", text: "Just as good, and simpler", outcome: "kept" };
    if (se != null && se >= 1.5) return { tone: "kept", text: "Better by a clear margin", outcome: "kept" };
    return { tone: "kept", text: "Better, and not just luck", outcome: "kept" };
  }
  if (se != null && se > 0.05) return { tone: "dropped", text: "A little better, but it could be luck", outcome: "dropped" };
  if (se != null && se < -2) return { tone: "dropped", text: "Clearly worse", outcome: "dropped" };
  if (se != null && se < -0.05) return { tone: "dropped", text: "Slightly worse", outcome: "dropped" };
  return { tone: "dropped", text: "No better", outcome: "dropped" };
}

/* ---- the timeline: experiment position → where the ball is on the climb ---- */

/**
 * Where the ball sits along the climb (index into the kept probes, fractional while it rolls) when the timeline's
 * playhead is at continuous experiment position `t` (0 = the first experiment). It rests on the latest keep while
 * the playhead crosses discards, and rolls to the next keep exactly across the step that decides it — so a keep is
 * reached the moment the playhead lands on it. `keeps` = indices of the kept experiments, ascending.
 */
export function beadAt(keeps: readonly number[], t: number): number {
  if (keeps.length === 0) return 0;
  const x = Number.isFinite(t) ? Math.max(0, t) : 0;
  const i = Math.floor(x);
  const f = x - i;
  let c = 0;
  while (c < keeps.length && keeps[c] <= i) c++;
  const base = Math.max(0, c - 1);
  if (c < keeps.length && keeps[c] === i + 1 && c > 0) return Math.min(keeps.length - 1, base + f);
  return base;
}

/** Indices of kept experiments, in order (the climb path). */
export function keptIndices(view: RunView): number[] {
  return view.experiments.filter((x) => x.status === "keep").map((x) => x.index);
}

/** The headline for a run's score on the locked test: "0.9936 ROC-AUC". */
export function scoreLine(view: RunView): string | null {
  if (!view.final) return null;
  return `${formatScore(view.metric, view.final.testScore)} ${metricInfo(view.metric).label}`;
}

/** Proposer note, worded plainly; null when it needs no note. */
export function proposerNote(proposer: string | null | undefined): string | null {
  if (!proposer) return null;
  if (proposer === "heuristic") return "Recorded without an LLM: ideas come from a built-in search.";
  return `Ideas proposed by ${proposer}.`;
}

/** A headline score: like formatScore, but large values are written out in full ("1,000,342", not "1M"). */
export function displayScore(metric: Metric | string | null | undefined, oriented: number | null | undefined): string {
  if (oriented == null || !Number.isFinite(oriented)) return "—";
  const raw = toRaw(metric, oriented);
  if (Math.abs(raw) >= 1e4) return Math.round(raw).toLocaleString("en-US");
  return formatScore(metric, oriented);
}
