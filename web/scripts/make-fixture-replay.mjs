// Builds the hand-written iris fixture (scripts/fixtures/iris-heuristic/{run.json,events.jsonl}), used only by
// scripts/fake-engine.mjs for UI work without Python. It is never listed as a public replay.
//
// This is a FIXTURE, not a real engine run: the numbers are hand-picked to be realistic for iris
// (5x2 repeated CV, log_loss), and run.json + events.jsonl are generated from one table so they agree.
// Real replays will be produced by the Python engine (`autotinker evolve ... --out <dir>`) and dropped
// into public/replays/<name>/ by hand; then add them to public/replays/index.json.
//
// Usage: node scripts/make-fixture-replay.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTwoFilesPatch } from "diff";

const here = dirname(fileURLToPath(import.meta.url));
const NAME = "iris-heuristic";
const outDir = resolve(here, "fixtures", NAME);
const RUN_ID = "r-fixture-iris-0001";
const T0 = Date.parse("2026-10-05T21:14:03.000Z");
const FOLDS = 10; // cv_folds 5 x cv_repeats 2

// ---------------------------------------------------------------- deterministic helpers
let s = 7;
const rand = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
/** Fold scores with exactly the given (oriented) mean and standard error. */
function folds(mean, se) {
  const z = Array.from({ length: FOLDS }, gauss);
  const m = z.reduce((a, b) => a + b, 0) / FOLDS;
  const sd = Math.sqrt(z.reduce((a, b) => a + (b - m) ** 2, 0) / (FOLDS - 1));
  const target = se * Math.sqrt(FOLDS);
  return z.map((v) => r6(mean + ((v - m) / sd) * target));
}

// ---------------------------------------------------------------- solution.py versions
const HEADER = `"""solution.py — the only file the agent edits. The harness imports build_pipeline()."""
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
`;
const code = {
  e000: `${HEADER}from sklearn.linear_model import LogisticRegression


def build_pipeline(profile: dict):
    return make_pipeline(
        StandardScaler(),
        LogisticRegression(max_iter=1000),
    )
`,
  e001: `${HEADER}from sklearn.linear_model import LogisticRegression


def build_pipeline(profile: dict):
    # Iris classes are nearly separable: weaken the L2 penalty so probabilities sharpen.
    return make_pipeline(
        StandardScaler(),
        LogisticRegression(C=10.0, max_iter=2000),
    )
`,
  e002: `"""solution.py — the only file the agent edits. The harness imports build_pipeline()."""
from sklearn.ensemble import HistGradientBoostingClassifier


def build_pipeline(profile: dict):
    # Radical: switch model family to gradient-boosted trees (no scaling needed).
    return HistGradientBoostingClassifier(
        learning_rate=0.1,
        max_iter=200,
        early_stopping=False,
        random_state=0,
    )
`,
  e003: `${HEADER}from sklearn.linear_model import LogisticRegression
import pandas as pd


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    # Row-wise, fit-free: petal area and length/width ratio separate versicolor/virginica.
    df = df.copy()
    df["petal.area"] = df["petal.length"] * df["petal.width"]
    df["petal.ratio"] = df["petal.length"] / (df["petal.width"] + 0.1)
    return df


def build_pipeline(profile: dict):
    # Iris classes are nearly separable: weaken the L2 penalty so probabilities sharpen.
    return make_pipeline(
        StandardScaler(),
        LogisticRegression(C=10.0, max_iter=2000),
    )
`,
  e004: `${HEADER}from sklearn.svm import SVC
import pandas as pd


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    # Row-wise, fit-free: petal area and length/width ratio separate versicolor/virginica.
    df = df.copy()
    df["petal.area"] = df["petal.length"] * df["petal.width"]
    df["petal.ratio"] = df["petal.length"] / (df["petal.width"] + 0.1)
    return df


def build_pipeline(profile: dict):
    # Radical: RBF-kernel SVM with Platt-scaled probabilities.
    return make_pipeline(
        StandardScaler(),
        SVC(C=3.0, gamma="scale", probability=True, random_state=0),
    )
`,
  e005: `${HEADER}from sklearn.linear_model import LogisticRegression
import pandas as pd


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    # Row-wise, fit-free: petal area and length/width ratio separate versicolor/virginica.
    df = df.copy()
    df["petal.area"] = df["petal.length"] * df["petal.width"]
    df["petal.ratio"] = df["petal.length"] / (df["petal.width"] + 0.1)
    return df


def build_pipeline(profile: dict):
    # Push regularisation further down.
    return make_pipeline(
        StandardScaler(),
        LogisticRegression(C=30.0, max_iter=4000),
    )
`,
  e006: `${HEADER}from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LogisticRegression
import pandas as pd

KEEP = ["sepal.length", "petal.length", "petal.width", "petal.area"]


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["petal.area"] = df["petal.length"] * df["petal.width"]
    return df


def build_pipeline(profile: dict):
    # Simplify: drop sepal.width and the ratio feature; keep only what carries signal.
    return make_pipeline(
        ColumnTransformer([("keep", StandardScaler(), KEEP)]),
        LogisticRegression(C=10.0, max_iter=2000),
    )
`,
};
code.e007 = code.e006
  .replace(
    "from sklearn.linear_model import LogisticRegression\n",
    "from sklearn.ensemble import VotingClassifier\nfrom sklearn.linear_model import LogisticRegression\nfrom sklearn.neighbors import KNeighborsClassifier\nfrom sklearn.svm import SVC\n",
  )
  .replace(
    `    return make_pipeline(
        ColumnTransformer([("keep", StandardScaler(), KEEP)]),
        LogisticRegression(C=10.0, max_iter=2000),
    )`,
    `    # Radical: soft-voting ensemble of three different model families.
    vote = VotingClassifier(
        [
            ("lr", LogisticRegression(C=10.0, max_iter=2000)),
            ("svc", SVC(C=3.0)),
            ("knn", KNeighborsClassifier(n_neighbors=7)),
        ],
        voting="soft",
    )
    return make_pipeline(ColumnTransformer([("keep", StandardScaler(), KEEP)]), vote)`,
  );
code.e008 = code.e006
  .replace("from sklearn.linear_model import LogisticRegression\n", "from sklearn.ensemble import RandomForestClassifier\n")
  .replace(
    `    return make_pipeline(
        ColumnTransformer([("keep", StandardScaler(), KEEP)]),
        LogisticRegression(C=10.0, max_iter=2000),
    )`,
    `    # Radical: bagged trees; scaling is harmless and keeps the column selection.
    return make_pipeline(
        ColumnTransformer([("keep", StandardScaler(), KEEP)]),
        RandomForestClassifier(n_estimators=500, min_samples_leaf=2, random_state=0),
    )`,
  );
code.e009 = code.e006
  .replace("from sklearn.linear_model import LogisticRegression\n", "from sklearn.neighbors import KNeighborsClassifier\n")
  .replace(
    `    return make_pipeline(
        ColumnTransformer([("keep", StandardScaler(), KEEP)]),
        LogisticRegression(C=10.0, max_iter=2000),
    )`,
    `    # Radical: distance-weighted nearest neighbours in the scaled petal space.
    return make_pipeline(
        ColumnTransformer([("keep", StandardScaler(), KEEP)]),
        KNeighborsClassifier(n_neighbors=11, weights="distance"),
    )`,
  );

// ---------------------------------------------------------------- the experiment table
// cv/sel are RAW log_loss (lower is better); stored oriented (negated) per contracts.py.
const E = [
  { id: "e000", parent: null, cat: "baseline", radical: false, title: "Baseline: standardised logistic regression",
    rationale: "Start from the unmodified starter solution so every later change is measured against a known reference.",
    status: "keep", cv: 0.1124, se: 0.0121, sel: 0.1042, fit: 0.021, dur: 6.8,
    reason: "Baseline is always kept." },
  { id: "e001", parent: "e000", cat: "hyperparameters", radical: false, title: "Weaken L2 regularisation (C=1 → 10)",
    rationale: "Profile shows near-separable classes; the default penalty keeps predicted probabilities soft, which log-loss punishes.",
    status: "keep", cv: 0.0812, se: 0.0103, sel: 0.0779, fit: 0.034, dur: 7.1,
    reason: "Paired t-test over 10 folds p=0.004; gain 0.0312 ≥ 0.5×SE (0.0051); select improved 0.1042 → 0.0779." },
  { id: "e002", parent: "e001", cat: "model_family", radical: true, title: "Switch to HistGradientBoosting",
    rationale: "Trees capture interactions without feature engineering; worth checking a different family early.",
    status: "discard", cv: 0.1418, se: 0.0214, sel: 0.1287, fit: 0.611, dur: 14.9,
    reason: "Worse than best (0.1418 vs 0.0812); 150 rows is too few for boosted trees to calibrate." },
  { id: "e003", parent: "e001", cat: "feature_engineering", radical: false, title: "Add petal area and petal length/width ratio",
    rationale: "Versicolor/virginica overlap along single petal axes; their product and ratio separate them more cleanly.",
    status: "keep", cv: 0.0743, se: 0.0091, sel: 0.0716, fit: 0.039, dur: 7.4,
    reason: "Paired t-test p=0.071; gain 0.0069 ≥ 0.5×SE (0.0046); select improved 0.0779 → 0.0716." },
  { id: "e004", parent: "e003", cat: "model_family", radical: true, title: "RBF-kernel SVM with Platt scaling",
    rationale: "A smooth non-linear boundary might fit the curved versicolor/virginica border better than a linear model.",
    status: "discard", cv: 0.0791, se: 0.0108, sel: 0.0762, fit: 0.118, dur: 9.6,
    reason: "Not better than best (0.0791 vs 0.0743); Platt scaling adds variance on small folds." },
  { id: "e005", parent: "e003", cat: "hyperparameters", radical: false, title: "Push regularisation further (C=10 → 30)",
    rationale: "The C=10 step helped a lot; check whether the curve keeps going.",
    status: "discard", cv: 0.0718, se: 0.0094, sel: 0.0721, fit: 0.047, dur: 7.2,
    reason: "Gain 0.0025 < 0.5×SE (0.0047), p=0.21 — indistinguishable from noise; select did not improve (0.0721 vs 0.0716)." },
  { id: "e006", parent: "e003", cat: "simplification", radical: false, title: "Drop sepal.width and the ratio feature",
    rationale: "sepal.width has the weakest class separation and the ratio is redundant with petal area; fewer inputs, same signal.",
    status: "keep", cv: 0.0741, se: 0.0090, sel: 0.0688, fit: 0.031, dur: 6.9,
    reason: "Gain 0.0002 is within noise, but the pipeline uses one fewer raw input and one fewer derived feature and fits faster (0.039 s → 0.031 s); select did not get worse (0.0716 → 0.0688) — kept by the simplicity rule." },
  { id: "e007", parent: "e006", cat: "ensembling", radical: true, title: "Soft-voting ensemble: LR + SVC + kNN",
    rationale: "Blending three different families often squeezes out the last gains on tabular data.",
    status: "crash", cv: null, se: null, sel: null, fit: null, dur: 11.3,
    reason: "Crashed after 1 repair attempt: SVC without probability=True cannot be used in soft voting.",
    error_kind: "runtime",
    error_tail: `Traceback (most recent call last):
  File "/harness/run.py", line 88, in score_folds
    proba = pipe.predict_proba(X_val)
  File "/site-packages/sklearn/pipeline.py", line 721, in predict_proba
    return self.steps[-1][1].predict_proba(Xt, **params)
  File "/site-packages/sklearn/ensemble/_voting.py", line 412, in predict_proba
    avg = np.average(self._collect_probas(X), axis=0, weights=self._weights_not_none)
  File "/site-packages/sklearn/ensemble/_voting.py", line 389, in _collect_probas
    return np.asarray([clf.predict_proba(X) for clf in self.estimators_])
  File "/site-packages/sklearn/svm/_base.py", line 829, in predict_proba
    self._check_proba()
  File "/site-packages/sklearn/svm/_base.py", line 796, in _check_proba
    raise AttributeError(
AttributeError: predict_proba is not available when probability=False` },
  { id: "e008", parent: "e006", cat: "model_family", radical: true, title: "Random forest on the reduced feature set",
    rationale: "Bagged trees are robust on small data and need little tuning; a different family to rule out a local optimum.",
    status: "discard", cv: 0.0987, se: 0.0152, sel: 0.0934, fit: 0.842, dur: 16.2,
    reason: "Worse than best (0.0987 vs 0.0741)." },
  { id: "e009", parent: "e006", cat: "model_family", radical: true, title: "Distance-weighted kNN (k=11)",
    rationale: "Iris clusters are compact in scaled petal space; a local method may calibrate well.",
    status: "discard", cv: 0.0905, se: 0.0133, sel: 0.0871, fit: 0.012, dur: 6.4,
    reason: "Worse than best (0.0905 vs 0.0741)." },
];

const LOC = (c) => c.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;

// ---------------------------------------------------------------- task & profile
const task = {
  target: "variety", problem_type: "multiclass", metric: "log_loss",
  description: "Classify iris flowers into three species from sepal and petal measurements.",
  seed: 0, cv_folds: 5, cv_repeats: 2, select_frac: 0.15, test_frac: 0.15,
  experiment_timeout_s: 120.0, experiment_memory_mb: 2048,
};
const col = (name, n_unique, examples, stats) => ({
  name, dtype: "float64", kind: "numeric", missing_frac: 0.0, n_unique, examples, stats, top_values: null, flags: [],
});
const profile = {
  n_rows: 150, n_cols: 5, target: "variety", problem_type: "multiclass", metric: "log_loss",
  columns: [
    col("sepal.length", 35, [5.1, 4.9, 6.3], { min: 4.3, max: 7.9, mean: 5.843, std: 0.828, q25: 5.1, q50: 5.8, q75: 6.4, skew: 0.315 }),
    col("sepal.width", 23, [3.5, 3.0, 2.8], { min: 2.0, max: 4.4, mean: 3.057, std: 0.436, q25: 2.8, q50: 3.0, q75: 3.3, skew: 0.319 }),
    col("petal.length", 43, [1.4, 4.7, 6.0], { min: 1.0, max: 6.9, mean: 3.758, std: 1.765, q25: 1.6, q50: 4.35, q75: 5.1, skew: -0.275 }),
    col("petal.width", 22, [0.2, 1.4, 2.5], { min: 0.1, max: 2.5, mean: 1.199, std: 0.762, q25: 0.3, q50: 1.3, q75: 1.8, skew: -0.103 }),
  ],
  target_summary: { kind: "classes", class_counts: { Setosa: 50, Versicolor: 50, Virginica: 50 }, n_classes: 3 },
  warnings: ["Small dataset (150 rows): CV standard errors will be wide relative to differences between models."],
  sample_rows: [
    { "sepal.length": 5.1, "sepal.width": 3.5, "petal.length": 1.4, "petal.width": 0.2, variety: "Setosa" },
    { "sepal.length": 7.0, "sepal.width": 3.2, "petal.length": 4.7, "petal.width": 1.4, variety: "Versicolor" },
    { "sepal.length": 6.3, "sepal.width": 3.3, "petal.length": 6.0, "petal.width": 2.5, variety: "Virginica" },
  ],
};
// Shaped like evolve/loop.py's run config (mode/proposer/max_repairs + gate + stop_rule).
const config = {
  mode: "evolve", proposer: "heuristic", max_repairs: 3, source: "examples/data/iris_classification.csv",
  gate: { name: "stat", alpha: 0.1, min_gain_se: 0.5 },
  stop_rule: { until: "ceiling", max_experiments: 30, max_cost_usd: 5.0, max_time_s: null, min_experiments: 10, noise_k: 2, radical_k: 3 },
};

// ---------------------------------------------------------------- build events + record
const events = [];
let seq = 0;
let t = T0;
const ts = () => new Date(t).toISOString();
const emit = (type, body) => events.push({ run_id: RUN_ID, seq: seq++, ts: ts(), type, ...body });

emit("run_started", { task, profile, config, proposer: "heuristic" });
t += 1400;

const experiments = [];
let best = null;
for (const e of E) {
  const startedAt = ts();
  const idea = { title: e.title, rationale: e.rationale, category: e.cat, radical: e.radical };
  emit("experiment_started", { exp_id: e.id, parent_id: e.parent, idea });
  const c = code[e.id];
  const parentCode = e.parent ? code[e.parent] : "";
  const diff = e.parent
    ? createTwoFilesPatch(`${e.parent}/solution.py`, `${e.id}/solution.py`, parentCode, c, "", "", { context: 3 })
        .split("\n").slice(1).join("\n") // drop the "====" header line
    : "";
  let cv = null;
  let selectScore = null;
  if (e.status === "crash") {
    t += e.dur * 450;
    emit("sandbox_finished", { exp_id: e.id, attempt: 0, ok: false, duration_s: r4(e.dur * 0.45), error_kind: e.error_kind, error_tail: e.error_tail });
    t += e.dur * 550;
    emit("sandbox_finished", { exp_id: e.id, attempt: 1, ok: false, duration_s: r4(e.dur * 0.55), error_kind: e.error_kind, error_tail: e.error_tail });
  } else {
    t += e.dur * 1000;
    emit("sandbox_finished", { exp_id: e.id, attempt: 0, ok: true, duration_s: e.dur, error_kind: null, error_tail: null });
    cv = { mean: -e.cv, se: e.se, folds: folds(-e.cv, e.se) };
    selectScore = -e.sel;
    emit("experiment_scored", { exp_id: e.id, cv, select_score: selectScore, fit_time_s: e.fit, loc: LOC(c) });
  }
  if (e.status === "keep") best = { id: e.id, mean: -e.cv };
  t += 120;
  emit("decision", { exp_id: e.id, decision: e.status, reason: e.reason, best_exp_id: best.id, best_cv_mean: best.mean });
  t += 900;
  experiments.push({
    id: e.id, parent_id: e.parent, idea, code: c, diff, status: e.status, reason: e.reason,
    cv, select_score: selectScore, fit_time_s: e.fit, loc: LOC(c),
    repair_attempts: e.status === "crash" ? 1 : 0, error_kind: e.error_kind ?? null, error_tail: e.error_tail ?? null,
    llm_calls: [], cost_usd: 0.0, duration_s: e.dur, started_at: startedAt,
  });
}

// Same keys and shapes as evolve/stopping.py `signals()`; external_ref is omitted when no reference is configured.
const report = {
  noise_floor: {
    value: 0.0069, threshold: 0.009, fired: true,
    detail: "the last 2 kept gains (0.0069, 0.0002) were each below the CV standard error (0.009)",
  },
  saturation: {
    value: 0.0011, threshold: 0.009, fired: true,
    detail: "the fitted curve (exp) predicts at most 0.0011 more",
    params: { a: -0.0730, b: 0.0394, c: 0.62 },
  },
  exploration: {
    value: 3, threshold: 3, fired: true,
    detail: "3 radical attempts were rejected since the last keep (need 3)",
  },
};
const summary =
  "Stopped at experiment 10 (e009): the last kept gains were each below the CV standard error (0.0090); " +
  "the fitted curve predicts at most 0.0011 more; 3 radical attempts since the last keep were rejected.";
t += 300;
emit("stopped", { reason: "ceiling", report, summary });

const bestE = E.find((e) => e.id === best.id);
const testRaw = 0.0839;
const final = {
  best_exp_id: best.id,
  dev_cv_mean: -bestE.cv,
  select_score: -bestE.sel,
  test_score: -testRaw,
  optimism_gap: r6(-bestE.sel - -testRaw), // select − test, oriented units
};
t += 2100;
const wall = r4((t - T0) / 1000);
emit("run_finished", { ...final, n_experiments: E.length, total_cost_usd: 0.0, wall_time_s: wall });

const record = {
  version: 1, run_id: RUN_ID, created_at: new Date(T0).toISOString(), mode: "evolve", proposer: "heuristic",
  task, profile, config, experiments, best_exp_id: best.id,
  stop: { reason: "ceiling", summary, report }, final,
  total_cost_usd: 0.0, total_input_tokens: 0, total_output_tokens: 0, wall_time_s: wall,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "run.json"), JSON.stringify(record, null, 2) + "\n");
writeFileSync(resolve(outDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`wrote ${events.length} events and ${experiments.length} experiments to ${outDir}`);
