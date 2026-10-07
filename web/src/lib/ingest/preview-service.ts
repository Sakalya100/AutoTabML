/**
 * Glue for POST /api/preview: fetch (cached briefly, so retyping the goal doesn't refetch the file), heuristics,
 * and the optional LLM refinement. Server-only.
 */
import { buildPreview, type Preview, type PreviewDeps } from "./fetch-preview";
import { llmSuggest, type LlmSuggestDeps } from "./llm-suggest";
import { metricFits, suggest, suggestionFor, type Suggestion } from "./suggest";
import { rewriteShareLink } from "./share-links";

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 40;
const g = globalThis as unknown as { __autotinkerPreviewCache?: Map<string, { at: number; preview: Preview }> };
const cache = (g.__autotinkerPreviewCache ??= new Map());

export async function cachedPreview(url: string, deps: PreviewDeps = {}): Promise<Preview> {
  const key = rewriteShareLink(url);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.preview, url: url.trim() };
  const preview = await buildPreview(url, deps);
  cache.set(key, { at: Date.now(), preview });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return preview;
}

export type LlmUse = "used" | "skipped" | "unavailable";

/** Heuristics first; ask the LLM when the user typed a goal or the heuristics were unsure. */
export async function suggestFor(preview: Preview, goal: string, deps: LlmSuggestDeps): Promise<{ suggestion: Suggestion | null; llm: LlmUse }> {
  const heuristic = suggest(preview.stats, goal);
  const wantLlm = goal.trim() !== "" || !heuristic || heuristic.ambiguous;
  if (!wantLlm) return { suggestion: heuristic, llm: "skipped" };
  if (!deps.groqKey && !deps.geminiKey) return { suggestion: heuristic, llm: "unavailable" };
  const out = await llmSuggest({ stats: preview.stats, sample: preview.sample, goal, heuristic }, deps);
  if (!out?.target) return { suggestion: heuristic, llm: "unavailable" };
  // The engine decides the problem type from the column's values, so derive it the same way; keep the LLM's metric
  // only if it is valid for that type.
  const base = suggestionFor(preview.stats, out.target, goal.trim() ? "matches your sentence" : "the likeliest column to predict", false);
  return {
    llm: "used",
    suggestion: {
      ...base,
      metric: out.metric && metricFits(base.problemType, out.metric) ? out.metric : base.metric,
      goalPlain: out.goalPlain ?? base.goalPlain,
      why: out.why ?? base.why,
      source: "llm",
      ambiguous: false,
    },
  };
}
