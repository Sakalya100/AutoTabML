/**
 * The account dashboard's data: the shape of `GET /api/dashboard?days=N` (backend), a forgiving parser that turns
 * whatever arrives into that shape, and the small pure helpers the page draws with (curves, scales, phrases).
 *
 * Scores arrive in each metric's natural direction (an RMSE is an RMSE). `gap` / `optimismGap` are already signed so
 * that positive means the locked test came out worse than the cross-validated estimate.
 */
import { greaterIsBetter } from "./metrics";

export interface DashSummary {
  sessions: number;
  runs: number;
  finished: number;
  failed: number;
  running: number;
  successRate: number | null;
  experiments: number;
  kept: number;
  keepRate: number | null;
  models: number;
  tokensIn: number;
  tokensOut: number;
  equivCostUsd: number;
  computeSeconds: number;
  avgRunSeconds: number | null;
  medianOptimismGap: number | null;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

export interface DashDay {
  date: string;
  runs: number;
  experiments: number;
  equivCostUsd: number;
  tokens: number;
}

export interface DashRun {
  id: string;
  sessionId: string;
  sessionTitle: string | null;
  status: string;
  createdAt: string | null;
  finishedAt: string | null;
  durationS: number | null;
  dataset: string | null;
  target: string | null;
  metric: string | null;
  problemType: string | null;
  experiments: number;
  kept: number;
  bestCv: number | null;
  testScore: number | null;
  optimismGap: number | null;
  equivCostUsd: number;
  tokens: number;
  errorCode: string | null;
  hasModel: boolean;
}

export interface DashQuality {
  runId: string;
  dataset: string;
  metric: string;
  cv: number;
  test: number;
  gap: number;
}

export interface DashProvider {
  model: string;
  calls: number;
  tokens: number;
  equivCostUsd: number;
}

export interface DashPricing {
  model: string;
  provider: string;
  input: number;
  output: number;
}

export interface Dashboard {
  summary: DashSummary;
  series: DashDay[];
  recentRuns: DashRun[];
  quality: DashQuality[];
  metrics: { metric: string; runs: number }[];
  providers: DashProvider[];
  pricing: DashPricing;
}

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

export const DEFAULT_PRICING: DashPricing = { model: "gpt-oss-120b", provider: "Groq", input: 0.15, output: 0.6 };

/* ---- parsing ---- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A finite number or null; numeric strings count ("12", "0.5"). */
export function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const num = (v: unknown): number => numOrNull(v) ?? 0;
const count = (v: unknown): number => Math.max(0, Math.round(num(v)));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : null);
const rate = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n == null ? null : Math.min(1, Math.max(0, n));
};

const DAY_MS = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Daily series, oldest first: sorted, duplicates summed, missing days between the first and last filled with zeros. */
export function normaliseSeries(raw: unknown): DashDay[] {
  const byDay = new Map<string, DashDay>();
  for (const r of arr(raw)) {
    if (!isObj(r)) continue;
    const date = str(r.date)?.slice(0, 10);
    if (!date || !Number.isFinite(dayMs(date))) continue;
    const prev = byDay.get(date) ?? { date, runs: 0, experiments: 0, equivCostUsd: 0, tokens: 0 };
    prev.runs += count(r.runs);
    prev.experiments += count(r.experiments);
    prev.equivCostUsd += Math.max(0, num(r.equivCostUsd));
    prev.tokens += count(r.tokens);
    byDay.set(date, prev);
  }
  const days = [...byDay.keys()].sort();
  if (days.length === 0) return [];
  const out: DashDay[] = [];
  for (let t = dayMs(days[0]); t <= dayMs(days[days.length - 1]); t += DAY_MS) {
    const d = isoDay(t);
    out.push(byDay.get(d) ?? { date: d, runs: 0, experiments: 0, equivCostUsd: 0, tokens: 0 });
  }
  return out;
}

function parseRun(r: Obj, i: number): DashRun {
  return {
    id: str(r.id) ?? `run-${i}`,
    sessionId: str(r.sessionId) ?? "",
    sessionTitle: str(r.sessionTitle),
    status: str(r.status) ?? "unknown",
    createdAt: str(r.createdAt),
    finishedAt: str(r.finishedAt),
    durationS: numOrNull(r.durationS),
    dataset: str(r.dataset),
    target: str(r.target),
    metric: str(r.metric),
    problemType: str(r.problemType),
    experiments: count(r.experiments),
    kept: count(r.kept),
    bestCv: numOrNull(r.bestCv),
    testScore: numOrNull(r.testScore),
    optimismGap: numOrNull(r.optimismGap),
    equivCostUsd: Math.max(0, num(r.equivCostUsd)),
    tokens: count(r.tokens),
    errorCode: str(r.errorCode),
    hasModel: r.hasModel === true,
  };
}

/** Whatever the endpoint sent, as a complete Dashboard: missing pieces become zeros / empty lists, never a crash. */
export function parseDashboard(raw: unknown): Dashboard {
  const o = isObj(raw) ? raw : {};
  const s = isObj(o.summary) ? o.summary : {};
  const summary: DashSummary = {
    sessions: count(s.sessions),
    runs: count(s.runs),
    finished: count(s.finished),
    failed: count(s.failed),
    running: count(s.running),
    successRate: rate(s.successRate),
    experiments: count(s.experiments),
    kept: count(s.kept),
    keepRate: rate(s.keepRate),
    models: count(s.models),
    tokensIn: count(s.tokensIn),
    tokensOut: count(s.tokensOut),
    equivCostUsd: Math.max(0, num(s.equivCostUsd)),
    computeSeconds: Math.max(0, num(s.computeSeconds)),
    avgRunSeconds: numOrNull(s.avgRunSeconds),
    medianOptimismGap: numOrNull(s.medianOptimismGap),
    firstRunAt: str(s.firstRunAt),
    lastRunAt: str(s.lastRunAt),
  };
  const recentRuns = arr(o.recentRuns)
    .filter(isObj)
    .map(parseRun)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 12);
  const quality: DashQuality[] = [];
  for (const q of arr(o.quality)) {
    if (!isObj(q)) continue;
    const cv = numOrNull(q.cv);
    const test = numOrNull(q.test);
    if (cv == null || test == null) continue;
    const metric = str(q.metric) ?? "score";
    const gap = numOrNull(q.gap) ?? (greaterIsBetter(metric) ? cv - test : test - cv);
    quality.push({ runId: str(q.runId) ?? `q-${quality.length}`, dataset: str(q.dataset) ?? "Untitled data", metric, cv, test, gap });
  }
  const metrics = arr(o.metrics)
    .filter(isObj)
    .map((m) => ({ metric: str(m.metric) ?? "score", runs: count(m.runs) }))
    .filter((m) => m.runs > 0)
    .sort((a, b) => b.runs - a.runs);
  const providers = arr(o.providers)
    .filter(isObj)
    .map((p) => ({ model: str(p.model) ?? "unknown model", calls: count(p.calls), tokens: count(p.tokens), equivCostUsd: Math.max(0, num(p.equivCostUsd)) }))
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
  const p = isObj(o.pricing) ? o.pricing : {};
  const pricing: DashPricing = {
    model: str(p.model) ?? DEFAULT_PRICING.model,
    provider: str(p.provider) ?? DEFAULT_PRICING.provider,
    input: numOrNull(p.input) ?? DEFAULT_PRICING.input,
    output: numOrNull(p.output) ?? DEFAULT_PRICING.output,
  };
  return { summary, series: normaliseSeries(o.series), recentRuns, quality, metrics, providers, pricing };
}

/** Nothing to show yet: no runs at all in the window and none listed. */
export const isEmptyDashboard = (d: Dashboard) => d.summary.runs === 0 && d.recentRuns.length === 0;

/* ---- words and numbers ---- */

export function greeting(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** "just now", "12m ago", "2h ago", "3d ago", then a date. */
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  // Round first, then pick the unit, so 59.6 minutes reads "1h ago", not "60m ago".
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(s / 3600);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(s / 86_400);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** 950 → "950", 12 400 → "12.4k", 3 210 000 → "3.21M". */
export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return `${(n / 1e3).toFixed(a < 1e4 ? 2 : a < 1e5 ? 1 : 0)}k`;
  if (a < 1e9) return `${(n / 1e6).toFixed(a < 1e7 ? 2 : a < 1e8 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

/** Equivalent dollars, with enough digits that small spends don't read as zero. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** 42 → "42s", 750 → "12m 30s", 7300 → "2h 02m". */
export function fmtSpan(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const fmtPct = (r: number | null | undefined) => (r == null ? "—" : `${Math.round(r * 100)}%`);

/** A score in its metric's own units, with as many digits as its size needs. */
export function fmtScore(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString("en-US");
  if (a >= 100) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

/** A gap with its sign spelled out: "+0.012" (test fell short), "−0.004" (test beat the estimate). */
export function fmtGap(g: number | null | undefined): string {
  if (g == null || !Number.isFinite(g)) return "—";
  const a = Math.abs(g);
  // Tiny gaps keep a fourth digit so they don't read as "−0.000"; anything smaller is simply zero.
  const s = a < 0.001 ? a.toFixed(4) : fmtScore(a);
  if (a < 5e-5) return "0";
  return `${g > 0 ? "+" : "−"}${s}`;
}

/** The header's one-liner: "12 runs · 148 experiments · last run 2h ago". */
export function subline(s: DashSummary, now = Date.now()): string {
  const parts = [`${s.runs} ${s.runs === 1 ? "run" : "runs"}`, `${s.experiments} ${s.experiments === 1 ? "experiment" : "experiments"}`];
  if (s.lastRunAt) parts.push(`last run ${relTime(s.lastRunAt, now)}`);
  return parts.join(" · ");
}

/** One sentence on whether the runs' own estimates held up on the locked test. */
export function honestySentence(q: DashQuality[]): string {
  if (q.length === 0) return "No finished runs yet: once one finishes, its estimate and its locked-test score land here.";
  const short = q.filter((p) => p.gap > 1e-9).length;
  const held = q.length - short;
  const n = q.length;
  if (short === 0) return `All ${n} finished ${n === 1 ? "run" : "runs"} matched or beat ${n === 1 ? "its" : "their"} own estimate on the locked test.`;
  if (held === 0) return `All ${n} finished runs scored a little lower on the locked test than they estimated: expected, and the gaps are small.`;
  return `${held} of ${n} finished runs matched or beat their own estimate on the locked test; ${short} fell a little short.`;
}

/* ---- charts ---- */

export interface Pt {
  x: number;
  y: number;
}

/**
 * A smooth path through points without overshoot (monotone cubic, Fritsch–Carlson / d3's curveMonotoneX), so a
 * day with zero runs never dips below the baseline.
 */
export function monotonePath(pts: Pt[]): string {
  const n = pts.length;
  if (n === 0) return "";
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  if (n === 1) return `M${f(pts[0].x)},${f(pts[0].y)}`;
  if (n === 2) return `M${f(pts[0].x)},${f(pts[0].y)}L${f(pts[1].x)},${f(pts[1].y)}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    m.push(dx[i] === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx[i]);
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t.push(0);
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]));
    }
  }
  t.push(m[n - 2]);
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f(pts[i].x + h)},${f(pts[i].y + t[i] * h)},${f(pts[i + 1].x - h)},${f(pts[i + 1].y - t[i + 1] * h)},${f(pts[i + 1].x)},${f(pts[i + 1].y)}`;
  }
  return d;
}

/** A round axis maximum at or above `v` (1, 2, 2.5, 5 × 10ⁿ), never zero. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const s of [1, 2, 2.5, 5, 10]) if (s * p >= v - 1e-12) return s * p;
  return 10 * p;
}

export interface HonestyPoint extends DashQuality {
  /** 0..1, better to the right / up, on the metric's own scale. */
  u: number;
  v: number;
}

/**
 * Places every run's (CV, test) pair on one square without lying about the diagonal. Each metric gets its own
 * affine scale (shared by both axes, so test = CV stays on the diagonal), flipped for lower-is-better metrics so
 * "better" is always up and right; below the diagonal then always means the test came out worse than the estimate.
 */
export function honestyPoints(q: DashQuality[]): HonestyPoint[] {
  const groups = new Map<string, DashQuality[]>();
  for (const p of q) groups.set(p.metric, [...(groups.get(p.metric) ?? []), p]);
  const out: HonestyPoint[] = [];
  for (const [metric, ps] of groups) {
    const sign = greaterIsBetter(metric) ? 1 : -1;
    const vals = ps.flatMap((p) => [sign * p.cv, sign * p.test]);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const mag = Math.max(Math.abs(lo), Math.abs(hi));
    const pad = Math.max((hi - lo) * 0.3, mag * 0.02, 1e-6);
    const a = lo - pad;
    const span = hi + pad - a;
    for (const p of ps) out.push({ ...p, u: (sign * p.cv - a) / span, v: (sign * p.test - a) / span });
  }
  return out;
}
