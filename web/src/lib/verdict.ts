/**
 * The keep / not-kept verdict in plain words, worded from the rule the engine's gate actually applied
 * (src/autotinker/evolve/gate.py), so the text never contradicts the numbers shown next to it.
 *
 * The stat gate compares a candidate with the current best on the same CV folds:
 *  - kept as an improvement: one-sided paired (Nadeau-Bengio corrected) t-test p < alpha, the mean gain is at least
 *    0.5 SE of the best, and the select-holdout score is not more than 1 SE worse;
 *  - kept as a simplification: the score moved by less than 0.25 SE (equally good) and the code is >= 15% shorter or
 *    fits in half the time. It replaces the best *without* being better, so it is never labelled "new best";
 *  - otherwise not kept, for the first rule that failed (not significant / gain too small / select holdout worse).
 *
 * Every number the engine writes is *oriented* (higher is better; log-loss, RMSE, MAE negated). Everything here is
 * shown in the metric's natural direction.
 */
import { fmtNum, greaterIsBetter, metricInfo, toRaw } from "./metrics";
import type { Decision, Metric } from "./schema";

export type GateKind =
  | "baseline"
  | "single_shot"
  | "improvement"
  | "simplification"
  | "not_significant"
  | "small_gain"
  | "select_disagrees"
  | "naive_keep"
  | "naive_discard"
  | "proposal_failed"
  | "crash"
  | "unknown";

export interface GateParse {
  kind: GateKind;
  p: number | null;
  /** Mean paired gain over the best, oriented (positive = better). */
  gain: number | null;
  /** The gain in units of the best's CV standard error (direction-free: positive = better). */
  gainSe: number | null;
  se: number | null;
  /** Select-holdout scores (oriented) and the floor the candidate had to clear. */
  select: { cand: number; best: number; floor: number } | null;
  /** What made a simplification simpler. */
  simpler: { loc: [number, number] | null; time: [number, number] | null };
}

const NUM = "([+\\-−]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+\\-]?\\d+)?)";
const num = (s: string | undefined): number | null => {
  if (s == null) return null;
  const v = Number(s.replace("−", "-"));
  return Number.isFinite(v) ? v : null;
};

/** Parse a gate reason string ("not significant: p=0.412 >= alpha=0.1; gain 0.01053 (+0.41 SE, …), …"). */
export function parseGate(reason: string | null | undefined, verdict?: Decision | null): GateParse {
  const r = (reason ?? "").trim();
  const head = r.split(";")[0].split(":")[0].trim().toLowerCase();
  let kind: GateKind = "unknown";
  if (verdict === "crash" || head === "proposal failed") kind = head === "proposal failed" ? "proposal_failed" : "crash";
  else if (head === "baseline") kind = "baseline";
  else if (head.startsWith("single-shot")) kind = "single_shot";
  else if (head === "improvement") kind = "improvement";
  else if (head === "simplification") kind = "simplification";
  else if (head === "not significant") kind = "not_significant";
  else if (head.startsWith("gain below")) kind = "small_gain";
  else if (head.startsWith("select holdout")) kind = "select_disagrees";
  else if (head === "naive") kind = verdict === "keep" || /improved by/.test(r) ? "naive_keep" : "naive_discard";
  else if (verdict === "keep" && !r) kind = "baseline";

  const gainM = new RegExp(`\\bgain ${NUM} \\(${NUM} SE, SE=${NUM}\\)`, "i").exec(r);
  const naiveM = new RegExp(`cv mean (?:improved by|did not improve) \\(?${NUM}`, "i").exec(r);
  const pM = new RegExp(`\\bp\\s*=\\s*${NUM}`, "i").exec(r);
  const selM = new RegExp(`select ${NUM} vs best ${NUM} \\(floor ${NUM}\\)`, "i").exec(r);
  const locM = /LOC (\d+)->(\d+)/.exec(r);
  const timeM = new RegExp(`fit time ${NUM}s->${NUM}s`).exec(r);
  const sel = selM ? { cand: num(selM[1]), best: num(selM[2]), floor: num(selM[3]) } : null;
  return {
    kind,
    p: num(pM?.[1]),
    gain: num(gainM?.[1] ?? naiveM?.[1]),
    gainSe: num(gainM?.[2]),
    se: num(gainM?.[3]),
    select: sel && sel.cand != null && sel.best != null && sel.floor != null ? { cand: sel.cand, best: sel.best, floor: sel.floor } : null,
    simpler: {
      loc: locM ? [Number(locM[1]), Number(locM[2])] : null,
      time: timeM && num(timeM[1]) != null && num(timeM[2]) != null ? [num(timeM[1])!, num(timeM[2])!] : null,
    },
  };
}

/** "p = 0.03", "p < 0.001". */
export function fmtP(p: number): string {
  if (p < 0.001) return "p < 0.001";
  if (p < 0.01) return `p = ${p.toFixed(3)}`;
  return `p = ${p.toFixed(2)}`;
}

/** True only when the gate kept the candidate *because it was better* (not the baseline, not a simplification). */
export function isNewBest(verdict: Decision | null | undefined, reason: string | null | undefined): boolean {
  if (verdict !== "keep") return false;
  const k = parseGate(reason, verdict).kind;
  return k === "improvement" || k === "naive_keep";
}

export interface VerdictInput {
  verdict: Decision;
  reason: string;
  metric: Metric | string | null | undefined;
  /** The candidate's CV mean (oriented). */
  candMean?: number | null;
  /** The best it was compared with (the best *before* this decision), oriented. */
  prev?: { id: string; mean: number } | null;
}

export interface VerdictText {
  kind: GateKind;
  /** "Kept", "Not kept", "Broke". */
  word: string;
  newBest: boolean;
  /** Why, in plain words: "better and not luck (p = 0.03)". */
  why: string;
  /** "Kept · new best — better and not luck (p = 0.03)". */
  line: string;
  /** The comparison the gate made, in natural units: "0.0387 vs 0.0492 for e000 · −0.0105 (0.41 SE)". */
  compare: string | null;
}

const WORD: Record<Decision, string> = { keep: "Kept", discard: "Not kept", crash: "Broke" };

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

/** The verdict as one plain line plus the comparison behind it. */
export function verdictText(v: VerdictInput): VerdictText {
  const g = parseGate(v.reason, v.verdict);
  const se = g.gainSe;
  const p = g.p != null ? fmtP(g.p) : null;
  const prevId = v.prev?.id ?? "the best";
  let why: string;
  switch (g.kind) {
    case "baseline":
      why = "the first score, the one to beat";
      break;
    case "single_shot":
      why = "the single-shot solution";
      break;
    case "improvement":
      why = `better and not luck${p ? ` (${p})` : ""}`;
      break;
    case "simplification": {
      const what = g.simpler.loc && !g.simpler.time ? "simpler code" : g.simpler.time && !g.simpler.loc ? "faster model" : "simpler model";
      why = `${what}, equally good (within noise)`;
      break;
    }
    case "not_significant":
      if (se != null && se > 0.05) why = `better on average but within noise${p ? ` (${p})` : ""}`;
      else if (se != null && se < -0.05) why = `worse than ${prevId}`;
      else why = `no better than ${prevId}`;
      break;
    case "small_gain":
      why = `better, but by too little to count${se != null ? ` (${se.toFixed(2)} SE; needs 0.5)` : ""}`;
      break;
    case "select_disagrees":
      why = "better in cross-validation, but worse on the held-out check";
      break;
    case "naive_keep":
      why = "the average score went up";
      break;
    case "naive_discard":
      why = "the average score did not go up";
      break;
    case "proposal_failed":
      why = "no runnable idea came back";
      break;
    case "crash": {
      const m = /^(\w+) after (\d+) repair/.exec(v.reason);
      why = m ? `${m[1].replace("_", " ")} error${Number(m[2]) ? ` after ${plural(Number(m[2]), "repair")}` : ""}` : "the code failed to run";
      break;
    }
    default:
      why = "";
  }
  const newBest = v.verdict === "keep" && (g.kind === "improvement" || g.kind === "naive_keep");
  const word = WORD[v.verdict] ?? v.verdict;
  const label = newBest ? `${word} · new best` : word;
  return { kind: g.kind, word, newBest, why, line: why ? `${label} — ${why}` : label, compare: compareText(v, g) };
}

/** "0.0387 vs 0.0492 for e000 · −0.0105 (0.41 SE)": the candidate against the best it was gated against. */
function compareText(v: VerdictInput, g: GateParse): string | null {
  if (v.verdict === "crash" || !v.prev || v.candMean == null) return null;
  if (g.kind === "baseline" || g.kind === "single_shot") return null;
  const d = metricInfo(v.metric).digits;
  const gain = g.gain ?? v.candMean - v.prev.mean; // the gate's own quantity: the mean paired gain on the same folds
  const raw = greaterIsBetter(v.metric) ? gain : -gain;
  const sign = raw > 0 ? "+" : raw < 0 ? "−" : "±";
  const seTxt = g.gainSe != null ? ` (${Math.abs(g.gainSe).toFixed(2)} SE ${g.gainSe >= 0 ? "better" : "worse"})` : "";
  return `${fmtNum(toRaw(v.metric, v.candMean), d)} vs ${fmtNum(toRaw(v.metric, v.prev.mean), d)} for ${v.prev.id} · ${sign}${fmtNum(Math.abs(raw), d)}${seTxt}`;
}

/**
 * The gate's reason with every number in natural units, for the detail views (never the oriented engine string):
 * "Not kept — better on average but within noise (p = 0.41). Gain −0.0105 log-loss (0.41 SE better), p = 0.41;
 * held-out 0.0341 vs best 0.0030 (had to be at most 0.0287)."
 */
export function plainGateReason(reason: string, verdict: Decision, metric: Metric | string | null | undefined): string {
  const g = parseGate(reason, verdict);
  const vt = verdictText({ verdict, reason, metric });
  const d = metricInfo(metric).digits;
  const up = greaterIsBetter(metric);
  const parts: string[] = [];
  if (g.gain != null) {
    const raw = up ? g.gain : -g.gain;
    const sign = raw > 0 ? "+" : raw < 0 ? "−" : "±";
    const seTxt = g.gainSe != null ? ` (${Math.abs(g.gainSe).toFixed(2)} SE ${g.gainSe >= 0 ? "better" : "worse"})` : "";
    parts.push(`change ${sign}${fmtNum(Math.abs(raw), d)} ${metricInfo(metric).label}${seTxt}${g.p != null ? `, ${fmtP(g.p)}` : ""}`);
  }
  if (g.select) {
    const f = (x: number) => fmtNum(toRaw(metric, x), d);
    parts.push(`held-out ${f(g.select.cand)} vs best ${f(g.select.best)} (had to be ${up ? "at least" : "at most"} ${f(g.select.floor)})`);
  }
  if (g.kind === "simplification") {
    if (g.simpler.loc) parts.push(`code ${g.simpler.loc[0]} → ${g.simpler.loc[1]} lines`);
    if (g.simpler.time) parts.push(`fit time ${fmtNum(g.simpler.time[0], 2)} s → ${fmtNum(g.simpler.time[1], 2)} s`);
  }
  if (g.kind === "proposal_failed") {
    const rest = reason.replace(/^proposal failed:\s*/i, "").trim();
    return rest ? `${vt.line}: ${rest}` : vt.line;
  }
  if (g.kind === "crash") return vt.line;
  return parts.length ? `${vt.line}. ${cap(parts.join("; "))}.` : vt.line;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
