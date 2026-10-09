/**
 * Sample payloads for the dashboard (development previews via `?fixture=demo|empty|loading|error`, and tests).
 * Deterministic: the same `days` and `now` always give the same numbers.
 */
import type { Dashboard, DashDay, DashRun } from "./dashboard";

const DAY = 86_400_000;

/** A tiny seeded PRNG (mulberry32), so the sample looks organic but never changes between renders. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS: Omit<DashRun, "id" | "sessionId" | "createdAt" | "finishedAt">[] = [
  {
    sessionTitle: "Churn, second pass",
    status: "running",
    durationS: null,
    dataset: "telco_churn.csv",
    target: "Churn",
    metric: "roc_auc",
    problemType: "binary",
    experiments: 9,
    kept: 2,
    bestCv: 0.8461,
    testScore: null,
    optimismGap: null,
    equivCostUsd: 0.0061,
    tokens: 31_200,
    errorCode: null,
    hasModel: false,
  },
  {
    sessionTitle: "House prices",
    status: "finished",
    durationS: 1288,
    dataset: "california_housing.csv",
    target: "median_house_value",
    metric: "rmse",
    problemType: "regression",
    experiments: 24,
    kept: 6,
    bestCv: 48_210.4,
    testScore: 49_102.7,
    optimismGap: 892.3,
    equivCostUsd: 0.0214,
    tokens: 104_800,
    errorCode: null,
    hasModel: true,
  },
  {
    sessionTitle: "Penguins",
    status: "finished",
    durationS: 412,
    dataset: "penguins.csv",
    target: "species",
    metric: "accuracy",
    problemType: "multiclass",
    experiments: 11,
    kept: 3,
    bestCv: 0.9853,
    testScore: 0.9855,
    optimismGap: -0.0002,
    equivCostUsd: 0.0072,
    tokens: 36_400,
    errorCode: null,
    hasModel: true,
  },
  {
    sessionTitle: "Wine quality",
    status: "failed",
    durationS: 18,
    dataset: "winequality-red.csv",
    target: "qualty",
    metric: null,
    problemType: null,
    experiments: 0,
    kept: 0,
    bestCv: null,
    testScore: null,
    optimismGap: null,
    equivCostUsd: 0,
    tokens: 0,
    errorCode: "target_missing",
    hasModel: false,
  },
  {
    sessionTitle: "Titanic",
    status: "finished",
    durationS: 655,
    dataset: "titanic.csv",
    target: "Survived",
    metric: "roc_auc",
    problemType: "binary",
    experiments: 18,
    kept: 4,
    bestCv: 0.8712,
    testScore: 0.8594,
    optimismGap: 0.0118,
    equivCostUsd: 0.0133,
    tokens: 66_900,
    errorCode: null,
    hasModel: true,
  },
  {
    sessionTitle: "Breast cancer",
    status: "finished",
    durationS: 530,
    dataset: "breast_cancer.csv",
    target: "diagnosis",
    metric: "roc_auc",
    problemType: "binary",
    experiments: 15,
    kept: 3,
    bestCv: 0.9937,
    testScore: 0.9911,
    optimismGap: 0.0026,
    equivCostUsd: 0.0098,
    tokens: 49_300,
    errorCode: null,
    hasModel: true,
  },
  {
    sessionTitle: "Bike sharing",
    status: "failed",
    durationS: 1801,
    dataset: "bike_hourly.csv",
    target: "cnt",
    metric: "mae",
    problemType: "regression",
    experiments: 31,
    kept: 7,
    bestCv: 26.41,
    testScore: null,
    optimismGap: null,
    equivCostUsd: 0.0251,
    tokens: 125_700,
    errorCode: "out_of_time",
    hasModel: false,
  },
  {
    sessionTitle: "Adult income",
    status: "finished",
    durationS: 977,
    dataset: "adult.csv",
    target: "income",
    metric: "roc_auc",
    problemType: "binary",
    experiments: 21,
    kept: 5,
    bestCv: 0.9281,
    testScore: 0.9262,
    optimismGap: 0.0019,
    equivCostUsd: 0.0176,
    tokens: 88_100,
    errorCode: null,
    hasModel: true,
  },
  {
    sessionTitle: "Diabetes",
    status: "finished",
    durationS: 344,
    dataset: "diabetes.csv",
    target: "progression",
    metric: "mae",
    problemType: "regression",
    experiments: 12,
    kept: 2,
    bestCv: 44.12,
    testScore: 45.9,
    optimismGap: 1.78,
    equivCostUsd: 0.0069,
    tokens: 34_500,
    errorCode: null,
    hasModel: true,
  },
  {
    sessionTitle: "Iris",
    status: "finished",
    durationS: 121,
    dataset: "iris.csv",
    target: "species",
    metric: "accuracy",
    problemType: "multiclass",
    experiments: 6,
    kept: 1,
    bestCv: 0.9667,
    testScore: 0.9333,
    optimismGap: 0.0334,
    equivCostUsd: 0.0031,
    tokens: 15_600,
    errorCode: null,
    hasModel: true,
  },
];

export function demoDashboard(days = 30, now = Date.parse("2026-10-09T18:30:00Z")): Dashboard {
  const r = rng(days * 7919);
  const today = Math.floor(now / DAY) * DAY;
  const series: DashDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const wave = 0.55 + 0.45 * Math.sin((days - i) / 3.1);
    const runs = r() < 0.28 ? 0 : Math.round(r() * 3 * wave);
    const experiments = runs === 0 ? 0 : Math.round(runs * (8 + r() * 14));
    const tokens = experiments * Math.round(4200 + r() * 1400);
    series.push({ date: new Date(today - i * DAY).toISOString().slice(0, 10), runs, experiments, equivCostUsd: tokens * 0.0000002, tokens });
  }
  const runs = series.reduce((a, d) => a + d.runs, 0) || RUNS.length;
  const experiments = series.reduce((a, d) => a + d.experiments, 0) || 147;
  const tokens = series.reduce((a, d) => a + d.tokens, 0);
  const recentRuns: DashRun[] = RUNS.map((x, i) => {
    const created = now - (i === 0 ? 4 * 60_000 : (i * i * 0.37 + i * 2.1) * 3600_000);
    return {
      ...x,
      id: `demo-run-${i}`,
      sessionId: `demo-session-${i}`,
      createdAt: new Date(created).toISOString(),
      finishedAt: x.durationS ? new Date(created + x.durationS * 1000).toISOString() : null,
    };
  });
  const quality = recentRuns
    .filter((x) => x.status === "finished" && x.bestCv != null && x.testScore != null)
    .map((x) => ({ runId: x.id, dataset: x.dataset ?? "data", metric: x.metric ?? "score", cv: x.bestCv!, test: x.testScore!, gap: x.optimismGap ?? 0 }));
  const failed = Math.max(1, Math.round(runs * 0.14));
  return {
    summary: {
      sessions: Math.max(1, Math.round(runs * 0.7)),
      runs,
      finished: runs - failed - 1,
      failed,
      running: 1,
      successRate: (runs - failed - 1) / Math.max(1, runs - 1),
      experiments,
      kept: Math.round(experiments * 0.23),
      keepRate: 0.23,
      models: Math.max(1, Math.round(runs * 0.72)),
      tokensIn: Math.round(tokens * 0.82),
      tokensOut: Math.round(tokens * 0.18),
      equivCostUsd: tokens * 0.0000002,
      computeSeconds: runs * 611,
      avgRunSeconds: 611,
      medianOptimismGap: 0.0026,
      firstRunAt: new Date(now - (days - 1) * DAY).toISOString(),
      lastRunAt: recentRuns[0].createdAt,
    },
    series,
    recentRuns,
    quality,
    metrics: [
      { metric: "roc_auc", runs: Math.round(runs * 0.45) },
      { metric: "accuracy", runs: Math.round(runs * 0.25) },
      { metric: "mae", runs: Math.round(runs * 0.18) },
      { metric: "rmse", runs: Math.max(1, Math.round(runs * 0.12)) },
    ],
    providers: [
      { model: "openai/gpt-oss-120b", calls: Math.round(experiments * 2.1), tokens: Math.round(tokens * 0.78), equivCostUsd: tokens * 0.78 * 0.0000002 },
      { model: "qwen/qwen3-32b", calls: Math.round(experiments * 0.5), tokens: Math.round(tokens * 0.17), equivCostUsd: tokens * 0.17 * 0.0000002 },
      { model: "llama-3.3-70b", calls: Math.round(experiments * 0.12), tokens: Math.round(tokens * 0.05), equivCostUsd: tokens * 0.05 * 0.0000002 },
    ],
    pricing: { model: "gpt-oss-120b", provider: "Groq", input: 0.15, output: 0.6 },
  };
}

export function emptyDashboard(days = 30, now = Date.parse("2026-10-09T18:30:00Z")): Dashboard {
  const d = demoDashboard(days, now);
  return {
    summary: {
      sessions: 0,
      runs: 0,
      finished: 0,
      failed: 0,
      running: 0,
      successRate: null,
      experiments: 0,
      kept: 0,
      keepRate: null,
      models: 0,
      tokensIn: 0,
      tokensOut: 0,
      equivCostUsd: 0,
      computeSeconds: 0,
      avgRunSeconds: null,
      medianOptimismGap: null,
      firstRunAt: null,
      lastRunAt: null,
    },
    series: d.series.map((x) => ({ ...x, runs: 0, experiments: 0, equivCostUsd: 0, tokens: 0 })),
    recentRuns: [],
    quality: [],
    metrics: [],
    providers: [],
    pricing: d.pricing,
  };
}
