# Changelog

All notable changes to the `autotinker` package are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break the API).

## [Unreleased]

## [0.2.0] - 2026-10-10

### Added
- **Bring your own LLM for `autotinker run`.** `--llm provider:model` (or `AUTOTINKER_LLM`; the flag wins) makes every agent use that one model instead of the free Groq / Gemini pool; `--fast-llm` (or `AUTOTINKER_FAST_LLM`) serves the quick, cheap calls with a second model. Providers: `openai`, `anthropic` (its OpenAI-compatible endpoint), `groq`, `gemini`, `cerebras`, `openrouter`, `together`, `mistral`, `deepseek`, `ollama` (no key; `OLLAMA_BASE_URL`), and `compat:<model>@<base_url>` for any OpenAI-compatible server (key from `AUTOTINKER_LLM_API_KEY`, optional). Keys come from the provider's usual variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...); a missing key stops the run before it starts and names the variable. The model must support tool calling. Also in the SDK: `agentic_run(..., llm=..., fast_llm=...)`.
- `AUTOTINKER_NO_ROWS=1` keeps data rows out of every prompt (schema-only intake and profiling), for any provider. Without it, a model you bring may receive a few sample rows; the built-in pool still never sends rows to Gemini.
- `autotinker run --max-cost` (SDK: `max_cost_usd`): the actual spend that stops a run (default $0.50; the free tiers cost $0).

### Changed
- **Breaking:** `autotinker run --llm` no longer selects the legacy single-shot mode; it now picks the agents' model. Use `autotinker run --single-shot --llm <proposer>` (with `--cheap-llm` / `--max-repairs`) for single-shot. `run --llm heuristic` without `--single-shot` is an error that points to `--single-shot` or `autotinker evolve --llm heuristic`, and so are `--cheap-llm` / `--max-repairs` without `--single-shot` (they used to be ignored).
- README: architecture and agent-role diagrams in Mermaid (rendered as images on PyPI, which can't draw Mermaid), a "bring your own LLM" guide, and an author section in place of the v1 contributor list.
- `evolve --llm` accepts every keyed provider in the shared endpoint table (adds `gemini`, `cerebras`, `together`, `mistral`, `deepseek`), and sends `max_completion_tokens` to OpenAI.

## [0.1.0] - 2026-10-10

First public release of the v2 engine (formerly AutoTabML; a ground-up rewrite of the 2024 v1).

### Added
- **Agentic run** (`autotinker run`, `autotinker.api.agentic_run`). Agent roles (intake, profiler, planner, coder, critic, judge, tuner, ensembler, reporter) plan, code, debug, tune and ensemble scikit-learn pipelines, then score the locked test once and write a plain-language report. Live steering and graceful stop over stdin, a FIFO or a control file.
- **Free-tier model routing.** Groq (gpt-oss-120b) and Gemini Flash-Lite by default; Cerebras is available but off by default. Per-model rate-limit buckets, failover, and per-call token and would-be-cost accounting. Requests that contain data rows are never sent to a provider that trains on inputs (Gemini).
- **Self-improvement loop** (`autotinker evolve`). Single-agent hill-climbing from a starter pipeline, with an offline heuristic proposer (`--llm heuristic`, no API key) or any of Anthropic, OpenAI, Groq, OpenRouter or an OpenAI-compatible server.
- **Harness.** Frozen dev / select / locked-test split, repeated k-fold CV, AST static checks against an import allowlist, and a sandboxed worker process (timeout, memory watchdog, no network, no secrets).
- **Statistical gate.** Corrected paired t-test (Nadeau–Bengio) plus a noise-floor margin and a select-holdout check; a `naive` gate for ablations.
- **Ceiling stop rule.** Noise floor, saturation-curve fit, exhausted radical exploration and an optional external reference, with experiment, cost, time and token budgets.
- **Data sources.** CSV / TSV / parquet files; `https://` links (GitHub, Google Drive / Sheets and Hugging Face share links rewritten to direct downloads); `openml:<id>`; `kaggle:<owner>/<dataset>`. Delimiter, encoding and decimal mark are detected, with `--delimiter`, `--encoding` and `--decimal` overrides. Plain-language failures for unusable data.
- **Run outputs.** `run.json` (replayable record), `events.jsonl` (typed event stream with JSON Schemas), `ledger.jsonl`, `best_solution.py`; for agentic runs also `report.json` and `assets/` (`model.joblib`, standalone `predict.py`, `pipeline.py`, pinned `requirements.txt`, `model_card.json`).
- **Python SDK.** `AutoTinker(...).evolve()` / `.run()`, and `Run` with `leaderboard`, `best`, `stop_report`, `test_score`, `predict()`, `export()`; `load_run()`.
- **CLI.** `autotinker run | evolve | replay | schema`, with `--events-stdout` for a machine-readable JSONL stream.
- **Packaging.** Typed package (`py.typed`); extras `boost` (LightGBM, XGBoost, CatBoost), `parquet`, `openml`, `kaggle`, `otel`; PyPI release workflow using Trusted Publishing.

### Not in the package
- The web app (`web/`, Next.js) and its API (`backend/`, FastAPI) live in the same repository and run at [autotinker.sakalya.si](https://autotinker.sakalya.si); they aren't part of the PyPI distribution.

### Known limitations
- The benchmark so far is a smoke test: offline heuristic proposer, one seed, five small datasets. There the statistical gate did **not** beat the naive gate. A proper benchmark is Phase 3 of the [roadmap](https://github.com/Sakalya100/AutoTinker/blob/main/docs/ROADMAP.md).

[Unreleased]: https://github.com/Sakalya100/AutoTinker/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Sakalya100/AutoTinker/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Sakalya100/AutoTinker/releases/tag/v0.1.0
