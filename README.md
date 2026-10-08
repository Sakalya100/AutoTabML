# AutoTinker

*Thinks of an idea. Tries it. Keeps what works.*

**A self-improving agent for tabular ML.** AutoTinker writes a readable scikit-learn pipeline, runs it in a sandbox, and keeps improving it until it can show the remaining gains are just noise. You get code you own, a full record of every experiment, and an honest estimate of how well the result will do on unseen data.

It takes the loop from Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) (a fixed harness, one file the agent may edit, keep or revert, repeat) and applies it to tabular data. It also adds the two things that loop lacks:

1. **A keep/revert rule that doesn't overfit.** A change is kept only if it wins a *corrected* paired t-test across identical CV folds. It must also be bigger than the noise and must not get worse on a separate selection holdout.
2. **A principled stopping point.** The loop stops when four "ceiling" signals agree: the noise floor, a saturation-curve fit, exhausted exploration, and an optional external reference. It then writes a report explaining why.

A locked test split is scored **once**, at the very end. The **optimism gap** (selection score minus test score) shows how much the loop fooled itself.

> Formerly **AutoTabML**. v2 is a ground-up rewrite under the new name; the 2024 v1 (a Streamlit + CrewAI code generator) is in the git history before the `v2` branch.

---

## Quickstart

```bash
uv sync                                  # Python 3.11+
uv run autotinker evolve examples/data/housing_regression.csv --target price
```

Without `ANTHROPIC_API_KEY` set, AutoTinker uses an **offline heuristic proposer**. It mutates the pipeline from a fixed bank of ideas, needs no LLM, and labels its runs that way. With a key:

```bash
export ANTHROPIC_API_KEY=...
uv run autotinker evolve data.csv --target churn --llm anthropic:claude-sonnet-5-5 \
    --description "monthly churn for a telecom" --max-experiments 60 --max-cost 3
uv run autotinker replay runs/<run-id>/run.json      # the ledger and stop report
```

### SDK

```python
from autotinker import AutoTinker

at = AutoTinker(llm="anthropic:claude-sonnet-5-5")          # or "heuristic", "openai:…", "groq:…"
run = at.evolve("train.csv", target="price", until="ceiling", max_cost_usd=3, on_event=print)

run.leaderboard      # every experiment: idea, CV mean ± SE, select score, decision, reason
run.best.code        # the winning solution.py
run.stop_report      # which ceiling signals fired, with numbers
run.test_score       # the locked holdout, scored once
run.export("model/") # solution.py + standalone train.py + requirements + run.json
```

## How it works

```
 data ─► Profiler ─► Harness (read-only to the agent) ◄─────────────────────────┐
          compact      dev / select / LOCKED test split                          │
          profile,     repeated k-fold CV · sandboxed subprocess · scoring       │ ExecResult
          no raw rows                                                            │
                         Agent ── idea + new solution.py ──► static check ──► sandbox
                           ▲                                                     │
                           └── ledger + idea memory ◄── gate (keep/revert) ◄─────┘
                                                         stop rule (ceiling?) ──► score test once
```

| Part | What it does |
|---|---|
| **Profiler** | Column types, missing values, cardinality, skew, target balance, and flags for ID-like or leaky columns. The LLM sees only this summary and at most 5 sample rows, never the full table. |
| **Solution contract** | The agent edits one file, `solution.py`, which defines `build_pipeline(profile) -> sklearn estimator`. The harness does all fitting and scoring, so the agent never touches the data files and can't score its own splits. |
| **Static check** | AST checks against an import allowlist. They block file and network IO, `eval`/`exec`, dunder tricks, and `.fit` calls outside the pipeline (a common cause of leakage). |
| **Sandbox** | A separate process group with a wall-clock timeout, an RSS-watchdog memory limit (macOS ignores `RLIMIT_AS`), network blocked, an environment with no secrets, and a fresh temp directory. The worker returns only predictions. Labels for the select and test splits never leave the parent process. |
| **Gate** | Keep only if all three hold: the Nadeau–Bengio corrected paired t-test gives p < 0.1; the gain is at least 0.5 × the best's CV SE; and the select holdout doesn't get worse. A simplicity rule also keeps "same score, clearly simpler or faster" changes. `gate="naive"` (keep any improvement, autoresearch-style) is available for ablations. |
| **Stop rule** | Stop when all four signals fire: (1) recent kept gains are below the CV SE; (2) a fitted `a − b·e^(−ct)` curve predicts less than one SE of remaining gain; (3) K radical attempts since the last keep have failed; (4) the score is within ε of an external reference, if one is given. Budgets (experiments, $, time) always cap the run. |
| **Observability** | Every step emits a typed JSONL event ([schema](schema/events.schema.json)). Each run writes a replayable `run.json` (code, diffs, scores, decisions, tokens, cost). OpenTelemetry spans are available with the `otel` extra. |

## Web app

The web app is two services deployed together from the root `vercel.json`:
- `web/`: a frontend-only Next.js app. Watch a recorded run evolve (score chart with the noise band, the experiment ledger with code diffs, the stop report, the optimism gap), or paste a link to a CSV and watch a live agentic run in a session, steer it, and stop it.
- `backend/`: a FastAPI service for sessions, runs, the SSE event stream and link previews, on Neon Postgres. During development a run is a local engine process; on Vercel it is a Vercel Sandbox microVM with locked-down network egress.

```bash
uv sync && uv sync --project backend && (cd web && npm install)
make migrate      # apply backend/migrations to DATABASE_URL (repo-root .env)
make dev          # API on :8000, web on :3000
```

See [web/README.md](web/README.md) and [backend/.env.example](backend/.env.example).

## Benchmarks

`benchmarks/run.py` compares four systems on the same splits:
- the starter pipeline
- `evolve` with the statistical gate
- `evolve` with the naive gate (fixed 40-experiment budget)
- `evolve` stopping at the ceiling

Results go to [`benchmarks/results/`](benchmarks/results/).

**First results (offline heuristic proposer, one seed, small datasets). Treat them as a smoke test, not evidence yet.** Full table: [`benchmarks/results/heuristic.md`](benchmarks/results/heuristic.md).

| dataset (rows) | metric | starter | evolve, stat gate (40) | evolve, naive gate (40) | evolve, until ceiling |
|---|---|---|---|---|---|
| iris + NAs (150) | log loss ↓ | 0.167 | 0.107 | **0.074** | 0.107 (stopped at 21) |
| housing (545) | RMSE ↓ | 1.09M | 0.996M | **0.919M** | 1.00M (stopped at 19) |
| breast cancer (569) | ROC-AUC ↑ | 0.983 | **0.994** | 0.993 | **0.994** (stopped at 37) |
| wine (178) | log loss ↓ | 0.051 | **0.019** | 0.059 | 0.023 (stopped at 15) |
| diabetes (442) | RMSE ↓ | 70.7 | 66.0 | **60.4** | 65.3 (stopped at 12) |

What this does and doesn't show:
- **Evolving beats the starter on every dataset**, on a test split the loop never saw.
- **The ceiling rule used 104 experiments in total instead of 200 (48% fewer).** Its test scores matched or nearly matched the 40-experiment statistical-gate runs.
- **The statistical gate does *not* yet beat the naive gate.** Naive wins on 3 of 5 datasets. With a heuristic proposer that mostly makes small hyperparameter tweaks, the naive gate builds up many small gains that the strict gate rejects. On datasets this small, single-split test scores are themselves noisy, which is also why many optimism gaps are negative. The proper test of the gate needs larger datasets (OpenML), several seeds, and an LLM proposer. That is next on the [roadmap](docs/ROADMAP.md) (Phase 3.5).

Reproduce: `uv run python benchmarks/run.py --llm heuristic --max-experiments 40` (about 25 min on a laptop CPU).

## Develop

```bash
uv sync && uv run pytest -q && uv run ruff check src tests && uv run mypy
cd backend && uv sync && uv run pytest -q && uv run ruff check . && uv run mypy      # needs postgres or TEST_DATABASE_URL
cd web && npm ci && npm run lint && npm test && npm run build
```

The layout: `src/autotinker/{data,harness,agent,evolve,obs}`, `api.py` (SDK), `cli.py`; `backend/` (FastAPI); `web/` (Next.js); `benchmarks/`; `schema/` (generated JSON Schemas); [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Contributors

v2: [Sakalya Mitra](https://github.com/Sakalya100). v1 (2024): [Sakalya Mitra](https://github.com/Sakalya100), [shalusingh-tech](https://github.com/shalusingh-tech), [pmp438](https://github.com/pmp438), [vedant22p](https://github.com/vedant22p).

## License

MIT
