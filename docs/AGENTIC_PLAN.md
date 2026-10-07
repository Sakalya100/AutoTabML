# AutoTinker v3 — the agentic AutoML loop (ML first)

Status: plan, decisions confirmed 2026-10-08 (§11) · scope: **platform** (web + engine). Deep learning and the SDK come later.

## 0. The goal in one paragraph

A visitor pastes a public CSV link, confirms what to predict, and presses **Start**. A team of LLM agents
profiles the data, plans, writes model code, runs it in a sandbox, reads the errors, fixes them, tunes
hyperparameters, and keeps improving until the gains are noise. Every step streams into a chat. On the right, the
ball climbs the map live: **one position = one experiment**. Click any position to see what each agent thought,
wrote and ran for that experiment. At the end the visitor gets the metrics, the runs, the cost, the graphs, and
downloadable code and model. The offline heuristic path is removed.

## 1. What we keep (it is already the hard, honest part)

| Kept as-is | Why |
|---|---|
| **Frozen harness**: dev/select/locked-test splits, repeated k-fold CV, scorer | The agents can never touch the eval. This is autoresearch's `prepare.py` principle; MLE-STAR and R&D-Agent do the same. |
| **Sandbox runner**: subprocess with timeout, RSS watchdog, no network, scrubbed env | Now it runs agent-written code all day. |
| **Gate**: Nadeau-Bengio corrected paired t-test + select-holdout check + simplicity rule | Stops the agents from "improving" on noise. |
| **Ceiling stop rule** (4 signals + budgets) and **one locked test** at the end | This is the product's differentiator. |
| **Event stream + RunRecord + survey world + replay journey** | Extended additively (§6). |
| `ScriptedLLM` | A test double, not a product path. |

**The orchestrator is a deterministic state machine, not an LLM.** Agents are called *at stages* with a fixed
contract. The LLMs decide **what to try**; code decides **what counts**. That split is the honesty story, and it is
also what makes the system debuggable.

## 2. Agents

Each agent is one role with a system prompt, an input contract, a structured output and its own model. All of them
are configurable per role.

| Agent | When | Input | Output | Default model |
|---|---|---|---|---|
| **Intake** | once, before the run | URL preview (header, 50 rows), user's sentence | target, problem type, metric, plain-language goal, warnings | Qwen 3.8 |
| **Profiler** | once | code-computed profile (existing), sample rows | data story; risks: leakage, IDs, time order, imbalance; split advice | Qwen 3.8 |
| **Planner / Researcher** | each iteration | profile, journal summary, best code, ablation result | **one hypothesis**: an idea, which block it targets, and why | Qwen 3.8 (`reasoning_format: parsed`) |
| **Coder** | each iteration | hypothesis, current best `solution.py`, contract | full new `solution.py` + a short note | **gpt-oss-120b** |
| *Executor* | each attempt | code | ExecResult (existing harness, **not an LLM**) | — |
| **Debugger** | on crash, ≤ 5 tries, then abandon | code, error tail, diff, contract | patched `solution.py` | gpt-oss-120b |
| **Critic / Auditor** | after every scored experiment | code, diff, scores, profile | leakage / data-use / validity verdict (hard gate), plain-language "what we learned" | Qwen 3.8 |
| **Tuner** | when the improve loop stalls on a model family | best code, fold scores, budget | an Optuna search space + trial budget. **Optuna runs it in the sandbox**, not the LLM | Qwen 3.8 |
| **Ensembler** | near the end | top-k diverse kept solutions | a stacking/blending `solution.py` | gpt-oss-120b |
| **Reporter** | at the end | RunRecord | the final report: summary, what worked, caveats, next steps | Qwen 3.8 |

How the work is split:
- **Model choice.** The Coder and Debugger default to `openai/gpt-oss-120b`: it is a Production model, about 5× cheaper, allows 65K output tokens (a full file fits) and supports prompt caching. Qwen 3.8 (`qwen/qwen3.8-27b`) drives planning and judgement. It is a **Preview** model on Groq ("may be discontinued at short notice"), so every role falls back to gpt-oss-120b, and the model is per-role config, not architecture.
- **Classical vs LLM work.** Numerical search and stacking are classical tools the agents *use*. The LLM chooses the search space; Optuna and scikit-learn do the arithmetic. This is the agentic-BO / LLAMBO finding: the hybrid beats either alone.

## 3. The loop

```
INTAKE ─► PROFILE ─► BASELINE (starter solution, e000)
                         │
                         ▼
               DRAFTS: N=3 diverse model families (Planner → Coder → Execute → Debug ≤5 → Critic → Gate)
                         │
                         ▼
          ┌─► IMPROVE: one atomic hypothesis per experiment on the current best ──┐
          │      every 5 experiments: ABLATION of the best pipeline's blocks       │
          │      → Planner targets the most impactful block (MLE-STAR)            │
          │   stall on a family (2 non-keeps) ─► TUNE: Optuna, one experiment       │
          └──────────── gate decides keep / discard / crash ───────────────────────┘
                         │ stop rule fires (ceiling) or a budget runs out
                         ▼
               ENSEMBLE top-k kept (one experiment, gated like any other)
                         │
                         ▼
               LOCKED TEST, scored exactly once ─► REPORT
```

**Search policy.** First N drafts for diversity (AIDE). Then greedy, one atomic change at a time (AIDE /
autoresearch). Ablation-targeted refinement (MLE-STAR). When progress stalls, explore: branch from the second-best
kept node or force a new model family (the existing "radical" idea).

**What counts as "one ball position".** One experiment = one hypothesis → its code → its scored result. A tuning
phase (many Optuna trials) is **one** experiment: the ball moves once, and the trials appear in that experiment's
drill-down. Debug retries are attempts inside the same experiment.

**Guards** (hard gates, all deterministic, with the Critic adding an LLM opinion):
- static checks (existing AST rules)
- a leakage scan: fitting outside the pipeline, target-derived features, ID columns, time order
- a "suspiciously large jump" flag
- the corrected-t gate

**Budgets** (shown to the user before Start, enforced by the orchestrator):
- wall time: **≤ 40 min on Vercel Hobby**, because a sandbox session is capped at 45 min
- `max_cost_usd`, default $0.50 per run (free tiers: $0, but tokens are capped)
- max experiments, default 10
- per-run token cap

**Time-aware.** Early experiments use a 30% data subset and 3-fold CV (R&D-Agent). Full CV starts once a family
looks promising.

**Baseline / bar to beat.** The existing starter solution is e000. FLAML (light) is an optional second baseline.
**No AutoGluon in the sandbox**: its install size and time don't fit.

## 4. Ingest: a public CSV link, minimal clicks

1. **One input box.** The user pastes a link and, optionally, types one sentence ("predict churn").
2. **The server fetches a preview**, with SSRF guards:
   - an https allowlist of schemes; private, loopback and link-local IPs blocked after DNS resolution
   - at most 3 redirects, a 15 s timeout, a 50 MB cap
   - a content sniff: CSV, TSV or parquet
3. **Share links are rewritten** to downloadable ones:
   - GitHub `blob/` → `raw.githubusercontent.com`
   - Google Drive `file/d/<id>` → `uc?export=download&id=<id>`
   - Google Sheets → `export?format=csv`
   - Hugging Face `blob/` → `resolve/`
   - Kaggle (needs a token) comes later
4. **The Intake agent and heuristics propose** the target, problem type and metric as **editable chips** next to the preview.
5. **One Start button.** That's 2 actions (paste, Start), or 3 with an edit.
6. **The sandbox downloads the full file itself** (the same guards, enforced again inside it), so large data never passes through a serverless function.

File upload stays available as a secondary option.

## 5. The run UI: three panels

```
┌───────────┬────────────────────────────────────────┬──────────────────────────┐
│ SESSIONS  │ CHAT (streams every step)               │ THE MAP (live)           │
│ + New     │ you: <link> "predict churn"             │  ball climbs as          │
│ ● churn   │ Intake: target=churn · ROC-AUC  [edit]  │  experiments land;       │
│ ○ housing │ Profiler: 7,043 rows · 21 cols …        │  click a position →      │
│ ○ iris    │ Planner ▸ e004: try target-encoding …   │  experiment drawer       │
│           │ Coder ▸ wrote solution.py (diff ▸)      │                          │
│           │ Sandbox ▸ crashed: KeyError 'tenure'    │  budget: 12 min · $0.21  │
│           │ Debugger ▸ fixed (1 try) ▸ re-run        │  best: 0.8473 ROC-AUC     │
│           │ Gate ▸ kept: +0.006 (p=0.03)  ●         │                          │
│           │ [ steer: "focus on recall" ] [ Stop ]   │                          │
└───────────┴────────────────────────────────────────┴──────────────────────────┘
```

- **Chat.**
  - Each agent step is a message with a plain first line; its reasoning, code, diff and logs sit behind disclosure.
  - Groq's structured outputs **can't stream**, so we stream at **step granularity**: started → reasoning (Qwen `parsed` reasoning) → finished, carrying the parsed result. Prose-only calls (Reporter, Critic notes) stream tokens.
  - Sandbox stdout streams live.
- **Steering.** The user can type mid-run. The orchestrator turns the message into a constraint for the next Planner call ("prefer recall", "no deep models") or a control action (Stop, Extend budget). The frozen harness never changes.
- **Experiment drawer** (click a ball position or a chat message):
  - the agent timeline for that experiment: Planner → Coder → Executor → Debugger×n → Critic → Gate
  - for each step: model, prompt summary, reasoning, tool calls, the code or diff, the stdout/stderr tail, tokens, cost and duration
  - for tuning experiments, the Optuna trial table and a chart
- **End-of-run report:**
  - **metrics:** CV ± SE, the locked test with a bootstrap CI, the optimism gap
  - **graphs:** the score trajectory, ROC/PR curves or residuals, the confusion matrix, feature importance, the tuning history
  - **runs table:** every experiment
  - **cost by agent and model**
  - **downloads:** `solution.py`, a standalone `train.py`, `model.joblib`, `run.json`
  - the Reporter's summary
- **Replays and the landing page** keep the journey views. Their data becomes real LLM runs (§8).

## 6. Data model and events (additive)

- **`Experiment.steps: AgentStep[]`**
  - who: `role`, `model`, `attempt`
  - what it was given: `input_summary`
  - what it produced: `reasoning`, `output` (parsed JSON), `code`, `diff`, `tool_calls`
  - what happened when it ran: `stdout_tail`, `stderr_tail`
  - cost: `tokens_in/out/cached`, `cost_usd`, `duration_s`
- **New events:**
  - `agent_step_started`, `agent_reasoning`, `agent_step_finished`
  - `sandbox_log` (stdout lines, throttled)
  - `hpo_trial`
  - `user_message`, `steer_applied`
  - `report_ready`
- Existing events and fields stay, so the survey world, gate, stop rule, journey and replays keep working.
- **Storage:**
  - **Postgres** (Neon, from the Vercel Marketplace) for sessions, runs, experiments and steps (durable history)
  - **Upstash Redis** only for live tailing and the events in flight
  - **Vercel Blob** for artifacts (models, files)
- **Identity:** an anonymous signed cookie for each browser first; real auth (GitHub/Google) later.

## 7. Where things run on Vercel

- **Next.js on Vercel:** the UI, the API, the preview fetch, the SSE stream and the session DB.
- **Vercel Sandbox, one per run:** the Python engine runs the **orchestrator *and* the agent calls *and* the training code**.
  - The orchestrator lives here because a run takes minutes and a route handler can't stay alive that long.
  - It POSTs events to `/api/runs/[id]/ingest` → Redis → SSE.
  - Agent LLM calls go to Groq from inside the sandbox.
  - The network policy allows only `api.groq.com` and the dataset host.
  - **Agent-written code runs in a nested subprocess with no network**, using the existing harness sandbox.
- **Keys:**
  - the Groq key is a Vercel env var, injected by the sandbox firewall as a header (already designed), so it never sits in the VM's environment
  - BYOK stays optional
- **This runner path has never run for real.** Phase 0 proves it before anything else.

## 8. Removing the heuristic path, in a safe order

Every bundled replay — the landing hero, the gallery, all four journeys — and the README benchmark were recorded
with the heuristic proposer. Deleting it first would take the showcase down, so this is the order:

1. The agentic loop works end to end (Phases 1–4).
2. Record **4+ real Groq runs** (breast cancer, housing, wine, plus one new public-URL dataset) as replays. Budget roughly $1–3 in tokens.
3. Regenerate the landing facts and journey facts from them. The landing copy stays; the numbers change.
4. **Then remove:**
   - code: `agent/heuristic.py`, `HeuristicProposer`, `--llm heuristic`, the `"auto"→heuristic` fallback
   - UI: the heuristic option in `/new` and the API, the "recorded without an LLM" notes
   - tests and docs: the heuristic tests (replaced by ScriptedLLM-based ones), `benchmarks/results/heuristic.md` (replaced by an LLM benchmark)
5. With no LLM key configured, the engine **fails fast with a clear message** instead of falling back.

## 9. Phases

| Phase | What | Done when |
|---|---|---|
| **0. Sandbox spike** | one real Vercel Sandbox run on a preview deployment: install the engine, run a scripted loop, events → ingest → Redis → SSE in the browser; Groq reachable from the sandbox | a live run streams on a `*.vercel.app` preview |
| **1. Agents + loop (engine)** | role registry, Groq client (reasoning/JSON modes, retries, 429 `retry-after`, cost incl. cached tokens), Planner/Coder/Debugger/Critic/Tuner/Ensembler/Reporter, Optuna inside the harness, ablation, budgets, new events + `AgentStep` | `autotinker run <url> --target …` on breast cancer reaches the ceiling locally with real Groq; ScriptedLLM tests for every role and the state machine |
| **2. Ingest + minimal new run** | URL fetch with SSRF guards and rewrites, preview, Intake agent, editable chips, one Start | paste link → Start in ≤ 3 actions for 5 different public datasets |
| **3. Sessions + chat + live map** | Postgres sessions, three-panel layout, step-level streaming, steering, Stop | a full run is watchable live; reload resumes the session |
| **4. Drill-down + report** | experiment drawer with the agent timeline, report graphs, downloads, cost by agent | every ball position opens its full agent trace; report artifacts download |
| **5. Re-record + delete heuristic** | §8 | the landing and replays show real LLM runs; no heuristic code is left |
| later | deep learning (PyTorch on GPU sandboxes), SDK parity, Kaggle ingest, cross-run memory (DS-Agent-style cases) | — |

## 10. Ideas adopted from the research

- **autoresearch:** a frozen eval, one editable file, keep/revert, a results log, the simplicity rule, a fixed per-run budget.
- **AIDE:** drafts, then debug, then greedy improve; a solution tree with a summarised journal.
- **MLE-STAR:** ablation-targeted refinement; leakage and data-usage checkers as gates.
- **AutoKaggle:** role split, a cap of 5 debug attempts, then abandon the idea.
- **R&D-Agent:** fixed splits at the start, a test split never touched, subset-first prototyping, a time-aware schedule.
- **SELA / MLEvolve:** structured exploration when progress stalls (later: MCTS over ideas).
- **Agentic BO / LLAMBO:** the LLM designs the search space, Optuna searches it.
- **"Auteval"** — no exact match exists. We adopted the closest ideas:
  - automatic metric selection (Intake)
  - confidence intervals on the holdout score (AutoEval Done Right)
  - an evaluator agent that audits each *decision*, not just the final score (the Critic, after the AutoML Evaluation Agent)

## 11. Decisions (confirmed 2026-10-08)

1. **Groq:** free tier only, so we pool free providers instead (§12).
2. **Models per role:** as proposed in §2.
3. **Caps per run:** $0.50, **10 experiments**, 40 min.
4. **Sessions:** Neon Postgres (free tier).
5. **Identity:** anonymous cookie now, real auth later.
6. **Providers:** cycle Groq, Gemini and Cerebras (§12).
7. **"Auteval" is Braintrust `autoevals`** (§13).

## 12. The provider pool (free tiers, verified 2026-10-08)

Every key was tested with a real call.

| Provider | Models we use | Free limits | Status |
|---|---|---|---|
| **Groq** | `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` (Preview) | 8K TPM, 1K RPD (from response headers) | works |
| **Gemini** (OpenAI-compatible endpoint) | `gemini-3.1-flash-lite` / `gemini-3.5-flash-lite` (~15 RPM, ~500 RPD); `gemini-3.8-flash` (~20 RPD, used sparingly) | per *project*; resets at midnight Pacific | works |
| **Cerebras** | `gpt-oss-120b`, `qwen-3.8-27b` (the same models as Groq) | no free tier now. Adding a card gives a **one-time $5 credit for 30 days**, with 5 RPM and 1M tokens/day; you are never charged automatically | currently `402 payment_required` |

**Router** (in the engine; every agent call goes through it):
- **Model aliases, not provider names.** Each role asks for a model class (`code` = gpt-oss-120b, `reason` = qwen 3.8, `fast` = flash-lite). The router knows which providers serve each class: Groq ↔ Cerebras for gpt-oss and qwen, Gemini for flash-lite.
- **A token bucket per provider and model.** It is fed by `x-ratelimit-*` headers (Groq) and the published limits, and it picks the provider with the most headroom.
- **Failure handling:**
  - `429`: wait for `retry-after` or `RetryInfo`, or move to the next provider
  - `402`, or quota exhausted: **mark the provider down for the day** (fatal, never retried)
  - `5xx` or a timeout: back off and fall over to the next provider
- **Fit the request to the window.** Requests are sized to the smallest window, Groq's 8K TPM, which counts prompt + `max_tokens`. So prompts are compact: the profile summary, a ≤ 2K-token code excerpt and the error tail, and every prompt is measured before sending. Long files go to whichever provider has room.
- **Usage accounting.** Usage is recorded per call (provider, model, tokens, cached, latency) and becomes `AgentStep` cost. On free tiers the cost is $0, but the would-be cost is shown too.

**Capacity per run.** About 45 calls: ~6 one-off (intake, profile, tune, ensemble, report) + ~3–4 per experiment × 10, and up to +5 for debugging. That is ≈ 150–250K tokens. With Groq (1K RPD) and Gemini Flash-Lite (~500 RPD) together, that's roughly **15–25 runs a day for free**. Turning on the Cerebras trial adds ~1M tokens/day (+4–6 runs).

**Privacy rule (Gemini free tier trains on inputs):**
- Gemini receives **only the schema, summary statistics and code**, never sample rows.
- Sample rows (≤ 5) go only to Groq and Cerebras.
- The new-run screen says this in one plain line.

## 13. Braintrust `autoevals` in the loop

`pip install autoevals`. It needs no Braintrust account. It's pointed at our router through an OpenAI-compatible client. Its LLM scorers force a tool call, so the judge model must support `tool_choice`: tested per provider in Phase 1.

| Use | Scorer | Where |
|---|---|---|
| Validate every agent's structured output before acting on it | `ValidJSON(schema)` | after each agent call; failure triggers one repair re-ask |
| **Second opinion on leakage / validity** | `LLMClassifier` (A: valid · B: suspicious · C: leak), run on a *different provider* than the Critic | after the Critic; disagreement means discard, plus a note in the chat |
| Plan quality | `LLMClassifier` (fits the profile? one atomic change? not a repeat?) | Planner output; a low score triggers one re-plan |
| **Report faithfulness** | `NumericDiff` on every number the Reporter quotes vs `RunRecord`, plus `Factuality` on its claims | before the report is shown; mismatches are corrected |
| Prompt regression suite | `ExactMatch` / `ListContains` / `Battle` on ~20 golden cases | in CI (with ScriptedLLM fixtures) and a manual weekly run with real models |

Every judge call goes through the router and the budget, and the judge results appear in the experiment drawer as the "Audit" step.
