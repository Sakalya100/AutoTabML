/**
 * One small LLM call that refines the heuristic suggestion when the user typed a goal sentence or the heuristics
 * were unsure. Groq (gpt-oss-120b) first; Gemini flash-lite as a fallback.
 *
 * Privacy rule (docs/AGENTIC_PLAN.md §12): Gemini's free tier trains on inputs, so it receives ONLY column names and
 * summary statistics — never data rows. Up to 5 sample rows may go to Groq. Any failure or timeout returns null and
 * the caller keeps the heuristic suggestion silently.
 */
import type { ColumnStats } from "./csv";
import { metricFits, PROBLEM_TYPES, type ProblemType, type Suggestion } from "./suggest";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-120b";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-3.1-flash-lite";

export interface LlmSuggestInput {
  stats: ColumnStats[];
  /** Display sample; only the first 5 rows are used, and only with Groq. */
  sample: string[][];
  goal: string;
  heuristic: Suggestion | null;
}

export interface LlmSuggestDeps {
  fetch?: typeof fetch;
  groqKey?: string;
  geminiKey?: string;
  timeoutMs?: number;
}

const SYSTEM = `You set up a tabular machine-learning task from a CSV's columns.
Answer with ONE JSON object and nothing else:
{"target": <exact column name to predict>, "problem_type": "binary"|"multiclass"|"regression",
 "metric": "roc_auc"|"log_loss"|"accuracy"|"f1_macro" (classification) or "rmse"|"mae"|"r2" (regression),
 "goal_plain": <one short plain-English sentence for a non-expert>, "why": <at most 20 words>}
Never pick an ID, a free-text or a date column as the target. Prefer what the user's sentence asks for.`;

/** Column names + stats only. Safe for any provider. */
export function describeColumns(stats: ColumnStats[]): string {
  return stats
    .map((c) => {
      const range = c.min !== undefined ? ` range=[${c.min}, ${c.max}]` : "";
      return `- ${JSON.stringify(c.name)}: ${c.kind}, ${c.unique} distinct, ${c.missing} missing of ${c.count + c.missing}${range}`;
    })
    .join("\n");
}

export function buildMessages(input: LlmSuggestInput, withRows: boolean) {
  const parts = [`Columns:\n${describeColumns(input.stats)}`];
  if (withRows && input.sample.length) {
    const cols = input.stats.map((c) => c.name);
    parts.push(`First rows (JSON):\n${input.sample.slice(0, 5).map((r) => JSON.stringify(Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])))).join("\n")}`);
  }
  if (input.heuristic) parts.push(`A rule of thumb suggests target=${JSON.stringify(input.heuristic.target)} (${input.heuristic.problemType}).`);
  parts.push(input.goal.trim() ? `The user says: ${JSON.stringify(input.goal.trim().slice(0, 500))}` : "The user gave no sentence.");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** Validate the model's JSON against the columns; drop anything that doesn't fit. */
export function parseLlmSuggestion(text: string, stats: ColumnStats[]): Partial<Suggestion> | null {
  let obj: Record<string, unknown>;
  try {
    const m = /\{[\s\S]*\}/.exec(text);
    obj = JSON.parse(m ? m[0] : text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const target = typeof obj.target === "string" ? obj.target : null;
  if (!target || !stats.some((c) => c.name === target)) return null;
  const out: Partial<Suggestion> = { target, source: "llm" };
  const pt = obj.problem_type;
  if (typeof pt === "string" && (PROBLEM_TYPES as readonly string[]).includes(pt)) {
    out.problemType = pt as ProblemType;
    if (typeof obj.metric === "string" && metricFits(out.problemType, obj.metric)) out.metric = obj.metric;
  }
  if (typeof obj.goal_plain === "string" && obj.goal_plain.trim()) out.goalPlain = obj.goal_plain.trim().slice(0, 240);
  if (typeof obj.why === "string" && obj.why.trim()) out.why = obj.why.trim().slice(0, 240);
  return out;
}

async function call(url: string, key: string, body: Record<string, unknown>, deps: LlmSuggestDeps): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 8000);
  try {
    const res = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function llmSuggest(input: LlmSuggestInput, deps: LlmSuggestDeps): Promise<Partial<Suggestion> | null> {
  if (deps.groqKey) {
    const text = await call(
      GROQ_URL,
      deps.groqKey,
      { model: GROQ_MODEL, messages: buildMessages(input, true), response_format: { type: "json_object" }, temperature: 0.2, max_completion_tokens: 1200, reasoning_effort: "low" },
      deps,
    );
    const parsed = text ? parseLlmSuggestion(text, input.stats) : null;
    if (parsed) return parsed;
  }
  if (deps.geminiKey) {
    // No rows to Gemini — names and stats only.
    const text = await call(GEMINI_URL, deps.geminiKey, { model: GEMINI_MODEL, messages: buildMessages(input, false), response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 400 }, deps);
    const parsed = text ? parseLlmSuggestion(text, input.stats) : null;
    if (parsed) return parsed;
  }
  return null;
}
