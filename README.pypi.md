<!-- Generated from README.md by tools/readme_assets.py; edit README.md instead. -->

# AutoTinker

[![PyPI](https://img.shields.io/pypi/v/autotinker)](https://pypi.org/project/autotinker/)
[![Python](https://img.shields.io/pypi/pyversions/autotinker)](https://pypi.org/project/autotinker/)
[![CI](https://github.com/Sakalya100/AutoTinker/actions/workflows/ci.yml/badge.svg)](https://github.com/Sakalya100/AutoTinker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Sakalya100/AutoTinker/blob/main/LICENSE)

*Thinks of an idea. Tries it. Keeps what works.*

**A self-improving agent for tabular ML.** Give AutoTinker a table and a column to predict. It writes a readable scikit-learn pipeline, runs it in a sandbox, and keeps improving it until it can show the remaining gains are just noise. You get code you own, a record of every experiment and why it was kept or rejected, and one honest score on a test split the agent never saw. Try it in the browser at **[autotinker.sakalya.si](https://autotinker.sakalya.si)**.

> Formerly **AutoTabML**. v2 is a ground-up rewrite under the new name.

There are two ways to use it:
- **Web app** ([autotinker.sakalya.si](https://autotinker.sakalya.si)): paste a link to a CSV, watch the agents work live, steer or stop them, and download the model. Nothing to install.
- **Python package** (`pip install autotinker`): the same engine as a CLI and an SDK, running on your machine.

## Install

```bash
pip install autotinker                 # Python 3.11+
pip install "autotinker[boost]"        # + LightGBM, XGBoost, CatBoost as model options
```

Other extras: `parquet` (pyarrow, for `.parquet` files), `openml` (`openml:<id>` sources), `kaggle` (`kaggle:<owner>/<dataset>` sources), `otel` (OpenTelemetry spans). On macOS, LightGBM also needs `brew install libomp`. If it can't load, AutoTinker leaves it out of the allowed imports.

## Quickstart

### The agentic run (a free API key, or bring your own)

`autotinker run` is what the web app runs. A team of agent roles (intake, profiler, planner, coder, critic, judge, tuner, ensembler, reporter) plans, codes, debugs, tunes and ensembles, until the ceiling or a budget is reached.

```bash
export GROQ_API_KEY=...        # free: https://console.groq.com
export GEMINI_API_KEY=...      # free: https://aistudio.google.com (optional, a fallback)

autotinker run https://raw.githubusercontent.com/mwaskom/seaborn-data/master/penguins.csv \
    --target species --goal "predict the penguin species" --max-experiments 3
```

- **Sources:** an `https://` link (GitHub, Google Drive / Sheets and Hugging Face share links are rewritten to direct downloads), a local `.csv` / `.tsv` / `.parquet` path, `openml:<id>`, or `kaggle:<owner>/<dataset>`.
- **Target:** `--target` is optional; if you leave it out, the intake agent picks one from your `--goal`.
- **Budgets:** `--max-experiments` (default 10), `--max-time` in seconds (default 2400) and `--max-tokens` (default 400 000) cap the run.
- **CSV format:** delimiter, encoding and decimal mark are detected. Override them with `--delimiter ";"` (`, ; |` or tab), `--encoding` (`utf-8`, `utf-8-sig`, `cp1252`, `latin-1`) or `--decimal ","`.
- **Other options:** `--metric`, `--out` (default `runs/`) and `--seed`.
- **Keys:** read from the environment or a `.env` file in the current directory.

### Which LLM it uses: free by default, or bring your own

**Out of the box, `run` uses free tiers**, so a run costs $0:

| provider | key | role |
|---|---|---|
| Groq (gpt-oss-120b) | `GROQ_API_KEY` | main model for coding and reasoning |
| Gemini (Flash-Lite) | `GEMINI_API_KEY` | fast calls, and the fallback when Groq's free quota runs out |
| Cerebras | `CEREBRAS_API_KEY` | off by default; enable with `AUTOTINKER_DISABLED_PROVIDERS=""` |

Gemini's free tier may train on its inputs, so **requests that contain data rows are never sent to it**. Only the intake and profiler agents see sample rows; every other agent sees column summaries.

**Bring any LLM and key.** Pass `--llm provider:model` (or set `AUTOTINKER_LLM`) with that provider's key, and every agent uses your model instead of the free pool:

```bash
export OPENAI_API_KEY=...
autotinker run data.csv --target churn --llm openai:gpt-4.1-mini --max-cost 5

export ANTHROPIC_API_KEY=...
autotinker run data.csv --target churn --llm anthropic:claude-sonnet-5-5

# any OpenAI-compatible server: vLLM, LM Studio, a company gateway, ...
AUTOTINKER_LLM_API_KEY=... autotinker run data.csv --llm "compat:my-model@https://llm.example.com/v1"

# a local model with Ollama, no key at all
autotinker run data.csv --llm ollama:qwen3:14b
```

| `--llm` | key | endpoint |
|---|---|---|
| `openai:<model>` | `OPENAI_API_KEY` | api.openai.com |
| `anthropic:<model>` | `ANTHROPIC_API_KEY` | Anthropic's OpenAI-compatible API |
| `groq:<model>` | `GROQ_API_KEY` | api.groq.com |
| `gemini:<model>` | `GEMINI_API_KEY` | Gemini's OpenAI-compatible API |
| `openrouter:<model>` | `OPENROUTER_API_KEY` | openrouter.ai (hundreds of models behind one key) |
| `together:<model>` | `TOGETHER_API_KEY` | api.together.xyz |
| `mistral:<model>` | `MISTRAL_API_KEY` | api.mistral.ai |
| `deepseek:<model>` | `DEEPSEEK_API_KEY` | api.deepseek.com |
| `cerebras:<model>` | `CEREBRAS_API_KEY` | api.cerebras.ai |
| `ollama:<model>` | none | localhost:11434 (override with `OLLAMA_BASE_URL`) |
| `compat:<model>@<base_url>` | `AUTOTINKER_LLM_API_KEY` (optional) | any OpenAI-compatible server |

- **Tool calling:** the judge agent uses tool (function) calling, so pick a model that supports it. Current hosted models from these providers do; for a local model, choose one with tool support.
- **A cheaper second model:** `--fast-llm provider:model` (or `AUTOTINKER_FAST_LLM`) serves the quick, low-stakes calls, while `--llm` handles planning and coding.
- **Spending cap:** a run stops at **$0.50** of actual spend by default. A paid model may reach that before the experiment budget, so raise it with `--max-cost 5` when you use one. Free tiers (Groq, Gemini, Cerebras) count as $0, and other models are priced at list price when known.
- **Your data:** the intake and profiler agents send your model a few sample rows, as they do with Groq. Set `AUTOTINKER_NO_ROWS=1` to send column summaries only, with any provider.
- **What's been run live:** Groq and Gemini, natively and through `compat:`. The others speak the same OpenAI-compatible API and are covered by tests that mock their HTTP responses.

### Offline, no API key: `evolve`

`autotinker evolve` is the single-agent hill-climbing loop. With `--llm heuristic` it needs no LLM at all: an offline proposer mutates the pipeline from a fixed bank of ideas, and runs are labelled that way.

```bash
autotinker evolve https://raw.githubusercontent.com/mwaskom/seaborn-data/master/penguins.csv \
    --target species --llm heuristic --max-experiments 5
autotinker replay runs/<run-id>            # the experiment ledger and the stop report
```

`evolve` stops when the ceiling is reached (`--until ceiling`, the default) or at a budget: `--max-experiments` (default 50), `--max-cost` in USD (default 5), or `--max-time`. `--gate naive` keeps any improvement, autoresearch-style, for ablations.

To use an LLM, pass `--llm provider:model`, for example `anthropic:claude-sonnet-5-5` (`ANTHROPIC_API_KEY`), `openai:gpt-4o-mini` (`OPENAI_API_KEY`), `groq:<model>` (`GROQ_API_KEY`), `openrouter:<model>` (`OPENROUTER_API_KEY`), or `compat:<model>@<base_url>` for any OpenAI-compatible server. Without `--llm`, `evolve` uses Anthropic if `ANTHROPIC_API_KEY` is set and the offline proposer otherwise. Unlike `run`, `evolve` doesn't read `.env`, and `--target` is required.

### Python SDK

```python
import pandas as pd
from autotinker import AutoTinker, load_run

at = AutoTinker(llm="heuristic", workdir="runs")      # or "anthropic:claude-sonnet-5-5", "groq:…", …
run = at.evolve("train.csv", target="variety", max_experiments=20, until="ceiling")

run.leaderboard        # DataFrame: every experiment, CV mean ± SE, select score, decision, reason
run.best.code          # the winning solution.py
run.stop_report        # which ceiling signals fired, with numbers
run.test_score         # the locked test split, scored once (oriented: higher is better)
run.predict(new_df)    # refit the best pipeline in-process and predict (runs the generated code unsandboxed)
run.export("model/")   # solution.py, train.py, requirements.txt, profile.json, run.json, README.md
load_run("runs/<run-id>")   # reload a finished run
```

The agentic loop is `autotinker.api.agentic_run`, the function the `run` command calls (it needs a provider key):

```python
from autotinker.api import agentic_run

run = agentic_run("data.csv", target="price", goal="predict the sale price", max_experiments=10)
run = agentic_run("data.csv", target="price", llm="openai:gpt-4.1-mini")   # bring your own model
```

## What you get

Every run writes a directory under `runs/<run-id>/`:
- `run.json`: the replayable record: every experiment's code, diff, scores, decision and reason, plus tokens and cost. Inspect it with `autotinker replay`.
- `events.jsonl`: the typed event stream ([schema](https://github.com/Sakalya100/AutoTinker/blob/main/schema/events.schema.json)).
- `ledger.jsonl`: one line per experiment.
- `best_solution.py`: the winning `build_pipeline(profile)`.

An agentic `run` also writes `report.json` (a plain-language summary of what was tried and why) and `assets/`:
- `model.joblib`: the final model, fitted on dev + select and scored once on the test split.
- `predict.py`: a standalone script, `python predict.py new_rows.csv -o predictions.csv`. It writes predictions and, for classifiers, class probabilities.
- `pipeline.py`: the final solution source.
- `requirements.txt`: the exact library versions the model was trained with.
- `model_card.json`: the target, metric, classes, feature columns with dtypes, and the test score.

`evolve` doesn't write `assets/`; use `Run.export()` for a standalone project instead.

## How it works

It takes the loop from Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) (a fixed harness, one file the agent may edit, keep or revert, repeat) and applies it to tabular data. It adds the two things that loop lacks:

1. **A keep/revert rule that doesn't overfit.** A change is kept only if it wins a *corrected* paired t-test across identical CV folds. The gain must also be bigger than the noise, and the change must not get worse on a separate selection holdout.
2. **A principled stopping point.** The loop stops when the "ceiling" signals agree that more experiments won't help, and writes a report explaining why.

A locked test split is scored **once**, at the very end. The **optimism gap** (selection score minus test score) shows how much the loop fooled itself.

![The improvement loop: profile, propose, check, sandbox, gate, repeat until the ceiling, then one locked test](https://raw.githubusercontent.com/Sakalya100/AutoTinker/main/docs/assets/mermaid-1dfdb2f3e9.png)

The agentic `run` splits the agent into roles. Each experiment goes through the same path, and the loop ends with one look at the locked test:

![The agent roles in a run, from intake to the report](https://raw.githubusercontent.com/Sakalya100/AutoTinker/main/docs/assets/mermaid-db0b3aa743.png)

| Part | What it does |
|---|---|
| **Profiler** | Column types, missing values, cardinality, skew, target balance, and flags for ID-like or leaky columns. Agents work from this summary, not the table. |
| **Solution contract** | The agent edits one file, `solution.py`, which defines `build_pipeline(profile) -> sklearn estimator`. The harness does all fitting and scoring, so the agent never touches the data files and can't score its own splits. |
| **Static check** | AST checks against an import allowlist. They block file and network IO, `eval`/`exec`, dunder tricks, and `.fit` calls outside the pipeline (a common cause of leakage). |
| **Sandbox** | A separate process group with a wall-clock timeout, a memory watchdog, network blocked, an environment with no secrets, and a fresh temp directory. The worker returns only predictions; labels for the select and test splits never leave the parent process. |
| **Gate** | Keep only if all three hold: the Nadeau–Bengio corrected paired t-test gives p < 0.1; the gain is at least 0.5 × the best's CV SE; and the select holdout doesn't get worse. A simplicity rule also keeps "same score, clearly simpler or faster" changes. |
| **Stop rule** | Stop when all of these fire: (1) recent kept gains are below the CV SE; (2) a fitted `a − b·e^(−ct)` curve predicts less than one SE of remaining gain; (3) K radical attempts since the last keep have failed; (4) the score is within ε of an external reference, if one is given. Budgets always cap the run. |
| **Observability** | Every step emits a typed JSONL event; every run writes a replayable `run.json`. OpenTelemetry spans with the `otel` extra. |

## The web app (and self-hosting it)

![How the hosted web app is deployed](https://raw.githubusercontent.com/Sakalya100/AutoTinker/main/docs/assets/mermaid-d507a65ef5.png)

The live site is two Vercel services deployed together from the root `vercel.json`:
- `web/`: a frontend-only Next.js app. Paste a link to a CSV, watch a live run, steer it and stop it, download the model; or watch a recorded run (score chart with the noise band, the ledger with code diffs, the stop report). Sign-in is Clerk.
- `backend/`: a FastAPI service for sessions, runs, the SSE event stream and link previews, on Neon Postgres. On Vercel each run is a Vercel Sandbox microVM with locked-down network egress. In local development a run is a local engine process.

```bash
uv sync && uv sync --project backend && (cd web && npm install)
make migrate      # apply backend/migrations to DATABASE_URL (repo-root .env)
make dev          # API on :8000, web on :3000
```

Configuration: [backend/.env.example](https://github.com/Sakalya100/AutoTinker/blob/main/backend/.env.example) and [web/README.md](https://github.com/Sakalya100/AutoTinker/blob/main/web/README.md).

## Benchmarks

`benchmarks/run.py` compares four systems on the same splits: the starter pipeline, `evolve` with the statistical gate, `evolve` with the naive gate (both a fixed 40 experiments), and `evolve` stopping at the ceiling.

**First results (offline heuristic proposer, one seed, small datasets). Treat them as a smoke test, not evidence.** Full table: [benchmarks/results/heuristic.md](https://github.com/Sakalya100/AutoTinker/blob/main/benchmarks/results/heuristic.md).

| dataset (rows) | metric | starter | evolve, stat gate (40) | evolve, naive gate (40) | evolve, until ceiling |
|---|---|---|---|---|---|
| iris + NAs (150) | log loss ↓ | 0.167 | 0.107 | **0.074** | 0.107 (stopped at 21) |
| housing (545) | RMSE ↓ | 1.09M | 0.996M | **0.919M** | 1.00M (stopped at 19) |
| breast cancer (569) | ROC-AUC ↑ | 0.983 | **0.994** | 0.993 | **0.994** (stopped at 37) |
| wine (178) | log loss ↓ | 0.051 | **0.019** | 0.059 | 0.023 (stopped at 15) |
| diabetes (442) | RMSE ↓ | 70.7 | 66.0 | **60.4** | 65.3 (stopped at 12) |

What this does and doesn't show:
- **Evolving beats the starter on every dataset**, on a test split the loop never saw.
- **The ceiling rule used 104 experiments in total instead of 200 (48% fewer)**, with test scores that matched or nearly matched the 40-experiment statistical-gate runs.
- **The statistical gate does *not* yet beat the naive gate.** Naive wins on 3 of 5 datasets. A heuristic proposer mostly makes small hyperparameter tweaks; the naive gate builds up many small gains that the strict gate rejects. On datasets this small, single-split test scores are themselves noisy, which is also why many optimism gaps are negative.

The proper test needs larger datasets (OpenML), several seeds, an LLM proposer and strong baselines. That is **benchmark v1, Phase 3 of the [roadmap](https://github.com/Sakalya100/AutoTinker/blob/main/docs/ROADMAP.md)**. Reproduce the table from a clone: `uv run python benchmarks/run.py --llm heuristic --max-experiments 40` (about 25 minutes on a laptop CPU).

## Develop

```bash
uv sync && uv run pytest -q && uv run ruff check src tests benchmarks && uv run mypy
cd backend && uv sync && uv run pytest -q && uv run ruff check . && uv run mypy      # needs postgres or TEST_DATABASE_URL
cd web && npm ci && npm run lint && npm test && npm run build
```

The diagrams in this README are Mermaid. PyPI can't render Mermaid, so the package page uses `README.pypi.md`, generated from this file with each diagram as an image. After editing a diagram or this README, run `python tools/readme_assets.py render` and `python tools/readme_assets.py pypi`; a test fails if they're out of date.

The layout: `src/autotinker/{data,harness,agent,evolve,obs}`, `api.py` (SDK), `cli.py`; `backend/` (FastAPI); `web/` (Next.js); `benchmarks/`; `schema/` (generated JSON Schemas).

Further reading: the [roadmap](https://github.com/Sakalya100/AutoTinker/blob/main/docs/ROADMAP.md), [how releases are published](https://github.com/Sakalya100/AutoTinker/blob/main/docs/RELEASING.md), and the [changelog](https://github.com/Sakalya100/AutoTinker/blob/main/CHANGELOG.md).

## Author

Built by [Sakalya Mitra](https://github.com/Sakalya100).

## License

MIT
