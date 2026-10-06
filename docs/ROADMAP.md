# AutoTabML v2 — Execution Roadmap

> **One-line pitch:** an AI agent that keeps improving its own ML pipeline for a tabular problem, without supervision, until it can show the remaining gains are just noise. It runs every experiment in a sandbox, scores each one against data it never gets to see, records everything it does, and outputs readable code you own.

Status: planning · Drafted 2026-10-06

---

## 0. What we're building and why

### The three ideas this plan combines

| Idea | Taken from | What we change |
|---|---|---|
| **A fixed harness and one file the agent may edit.** The agent may change only one file; the data handling and scoring code are read-only. It keeps a change if the score improves and reverts it if not, and it never stops on its own. | Karpathy's `autoresearch` (Mar 2026): `prepare.py` is read-only, `train.py` is the only file the agent edits, `program.md` is written by the human, each run gets a fixed 5-min budget, results go to `results.tsv`, and the steps are commit → run → keep or `git reset` | We apply it to **tabular ML** instead of LLM pretraining. Experiments run on CPU in seconds to minutes, so hundreds per night are cheap. |
| **Search over a tree of attempts**, not just one line of commits | AIDE (draft / debug / improve steps over a tree of solutions), ShinkaEvolve (starts a new search branch when progress stalls) | We start with a single line of improvements and add branching only when progress stalls |
| **Run until the problem's ceiling** | Nobody does this in a principled way. autoresearch never stops; AIDE, R&D-Agent and Shinka stop when a step, time or cost budget runs out; OpenEvolve has an optional patience counter that is off by default | **This is our new contribution:** a stopping rule based on statistics (see §3.4) |

### Why this is the right resume project

- autoresearch's main criticism is **overfitting the validation set**: hundreds of evaluations against one fixed split. Tobi Lütke said of his own run that it was "probably somewhat overfit", and Shopify's 53% claim was flagged as overfit to its benchmark. Our harness is designed to **measure and limit** that problem. That gives us something new to say rather than another copy.
- Tabular ML is cheap to run, so we can do real experiments on a laptop and produce **benchmark numbers**.
- The final story: *"I took autoresearch's loop, applied it to a new domain, measured how much it overfits, fixed that, and added a principled stopping rule."* That is a strong interview conversation.

### What we're not building

- Lots of role-play agents. One agent with tools runs the loop.
- Our own trace storage backend. We use OpenTelemetry and send data to Langfuse or Phoenix.
- Deep learning on tabular data in v2. We stick to sklearn, XGBoost, LightGBM and CatBoost, and maybe TabPFN later.

---

## 1. Target architecture

```
                ┌──────────────────────────── autotabml (PyPI) ─────────────────────────────┐
 data sources   │                                                                            │
 CSV / pandas ─►│ DataSource ─► Profiler ─► TaskSpec ─► Harness (READ-ONLY to the agent)     │
 OpenML       ─►│   adapters     (stats,     (target,     • fixed splits: dev / select / LOCKED test
 Kaggle (P6)  ─►│               no raw rows)  metric,     • repeated-CV scorer                  │
                │                             budget)     • sandbox runner (timeout, mem, no net)│
                │                                                 ▲                          │
                │                    ┌────────────────────────────┴───────┐                  │
                │   Brief (program.md analogue, human-editable)         │                  │
                │                    ▼                                    │ score / error    │
                │   Agent ──edits──► solution.py ──────────────────────►─┘                  │
                │     ▲                                                                      │
                │     └── Ledger (every experiment) + Idea memory + Plateau / ceiling detector│
                │                                                                            │
                │   RunRecord (JSON) + OpenTelemetry spans ──► Langfuse / Phoenix / UI        │
                └───────────────────────────────▲────────────────────────────────────────────┘
                                                │ SDK / events
                         CLI ◄──────────────────┼──────────────────► FastAPI (SSE) ─► Web UI
```

### Package layout

```
autotabml/
  data/        sources.py (csv, pandas, openml, kaggle), profiler.py
  task.py      TaskSpec (target, problem type, metric, budgets)
  harness/     splits.py, scorer.py, sandbox.py, contract.py
  agent/       llm.py (provider-agnostic), prompts/, actions.py (draft/improve/debug/explore)
  evolve/      loop.py, ledger.py, memory.py, stopping.py, search.py (tree/islands, P3b)
  obs/         record.py (RunRecord), otel.py
  api.py       public SDK surface
  cli.py
server/        FastAPI + SSE (Phase 5)
web/           frontend (Phase 5)
benchmarks/    suites, runner, baselines, report generator
legacy/        the 2024 Streamlit app, kept for history
```

### The `solution.py` contract (the agent's equivalent of `train.py`)

```python
# The ONLY file the agent edits. The harness imports it in a sandboxed subprocess.
def build_pipeline(profile: dict) -> "sklearn-compatible estimator":
    ...
# Optional:
def engineer_features(df: pd.DataFrame) -> pd.DataFrame:  # must be row-wise / fit-free, or live inside the pipeline
    ...
```

The harness does all fitting, cross-validation and scoring. The agent can't read the data files directly, so it can't leak test data or "evaluate" on its own split. That's the same rule as autoresearch keeping `evaluate_bpb` read-only.

---

## 2. Phases at a glance

| Phase | Theme | Rough effort (part-time) | Done when |
|---|---|---|---|
| 0 | Clean-up and foundations | 1 week | Packaging, CI and tests are set up; old app moved to `legacy/` |
| 1 | Core harness and single-shot agent with repair | 2–3 weeks | `autotabml run iris.csv --target species` produces a scored `solution.py` in a sandbox |
| 2 | Benchmark v0 and baselines | 1 week | Score table for 15–20 OpenML datasets against sklearn, FLAML and AutoGluon |
| 3 | **Self-evolution loop and ceiling detection** | 3–4 weeks | `evolve(until="ceiling")` runs overnight, stops on its own, and reports how much it overfit the validation set |
| 4 | SDK, CLI and PyPI 0.1 | 1–2 weeks | `pip install autotabml` works; docs site is live |
| 5 | Observability UI and hosted demo | 3 weeks | Public demo with a live evolution chart, experiment tree, diffs, cost and replays |
| 6 | Kaggle integration | 2 weeks | Point it at a Kaggle dataset or competition and it fetches the data, evolves a solution and optionally submits |
| 7 | Write-up and launch | 1 week | Technical blog post or report, demo video, README with the score table |

Phases 0 → 3 are the core. Phases 4–7 make it usable and visible. **Don't start Phase 5 before Phase 3 has real numbers.**

---

## Phase 0 — Clean-up and foundations (≈1 week)

**Tasks**
- [ ] Move `app.py`, `autotabml_agents.py` and `autotabml_tasks.py` into `legacy/`. Add a note in the README saying v2 is in progress.
- [ ] Take down the sleeping Hugging Face Space, or point it at a "v2 coming" page. Its model, `llama3-70b-8192`, has probably been retired by Groq.
- [ ] Set up `pyproject.toml` (hatchling), `uv`, `ruff`, `mypy` (strict on `autotabml/`), `pytest`, `pre-commit`.
- [ ] Add GitHub Actions: lint, type-check and tests on Python 3.11–3.13.
- [ ] Remove `tensorflow`. Pin dependencies through a lockfile.
- [ ] `CONTRIBUTING.md` and `CHANGELOG.md`. Keep the 2024 contributors credited.

**Done when:** CI passes on an empty package skeleton.

---

## Phase 1 — Core harness and single-shot agent with repair (≈2–3 weeks)

### 1.1 Data and profiling
- [ ] `DataSource` interface plus `CsvSource`, `PandasSource`, `OpenMLSource` (`openml.datasets.get_dataset(id).get_data(target=...)`, no key needed).
- [ ] `Profiler` computes a compact JSON summary that is generated by code, not by the LLM:
  - n_rows and n_cols
  - for each column: dtype, missing %, cardinality, a few example values, numeric quantiles, skew
  - for the target: class balance or distribution
  - suspicious columns: ID-like, near-constant, or likely to leak the target (very high correlation or mutual information with the target, a column name containing the target name, timestamps after the label)
- [ ] The LLM sees **only the profile and at most 5 sample rows**, never the full data.

### 1.2 Task spec
- [ ] `TaskSpec(target, problem_type=auto, metric=auto, time_budget_per_experiment, total_budget)`.
- [ ] Default metrics: classification uses ROC-AUC (binary) or log-loss (multiclass), plus accuracy for reporting. Regression uses RMSE and R².

### 1.3 Harness (read-only to the agent)
- [ ] **Three-way split, fixed by a seed:**
  - `dev`, about 70%: the agent gets repeated k-fold CV scores on this set
  - `select`, about 15%: used **only** by the loop to decide whether to keep or revert a change; the agent never sees these numbers directly
  - `test`, about 15%: **locked**, scored only once at the end of a run, and used to measure overfitting
  - Use stratified or grouped splitting where it applies. Time-series tasks get a split by time (P3+).
- [ ] Scorer: repeated k-fold on `dev` (e.g. 3×5). It returns the mean, the standard error and the score for each fold, so we can run paired tests later.
- [ ] **Sandbox runner:**
  - The local default is a subprocess with a wall-clock timeout, a memory limit (`resource.setrlimit` on Unix) and no network (environment variable plus a socket-blocking `sitecustomize`).
  - Add a Docker backend later.
  - The hosted demo uses an e2b or Modal backend (P5).
  - stdout and stderr are written to a log file, and the agent sees only the last N lines, like autoresearch's `tail -n 50 run.log`.
- [ ] Static checks before running:
  - the code parses (AST)
  - it uses only allowed imports
  - it doesn't touch the file system or call `subprocess`
  - it doesn't call `fit` outside the pipeline, which catches the common leak of fitting a scaler before the split
- [ ] Fail fast on NaN predictions or results that are clearly broken, like autoresearch's `FAIL` + `exit(1)`.

### 1.4 Agent v1 (single-shot with repair)
- [ ] `llm.py`: a provider-agnostic client (LiteLLM, or a thin wrapper around the Anthropic, OpenAI and Groq SDKs). Every call records model, tokens, cost and latency.
- [ ] Structured outputs with Pydantic: `Plan`, `SolutionCode`, `RepairPatch`. **No "compiler agent"** to pull code out of text.
- [ ] Action `draft`: profile + brief → `solution.py`.
- [ ] Action `debug`: error tail + code → patch, at most 3 tries per draft (AIDE uses `max_debug_depth: 3`).
- [ ] Write the loop ourselves, about 200 lines. We want to own and explain this part rather than hide it behind CrewAI.

### 1.5 Observability from day one
- [ ] `RunRecord` is a JSON file covering: task, profile, every attempt (code, diff, scores, error, tokens, cost, time), and the final test score.
- [ ] OpenTelemetry spans: `run > experiment > {llm_call, static_check, sandbox_exec, score}`. They follow the GenAI conventions and can be sent anywhere that accepts OTLP.

**Done when:** `autotabml run iris.csv --target species` and `autotabml run openml:31` each produce a scored `solution.py`, a `RunRecord`, and traces visible in local Phoenix or Langfuse. Tests cover splits, the scorer, the sandbox's timeout and memory kills, the static checks, and a mocked LLM.

---

## Phase 2 — Benchmark v0 (≈1 week)

- [ ] **Suite:** 15–20 OpenML datasets drawn from OpenML-CC18 classification and the AutoML Benchmark or Grinsztajn tabular-benchmark regression sets. Mix sizes from 1k to 100k rows, mixed column types, missing data and class imbalance.
- [ ] **Baselines on the same splits:**
  1. a default `HistGradientBoosting` model
  2. FLAML with the same time budget
  3. AutoGluon `medium_quality` with the same time budget
  4. AutoGluon `best_quality` with a large budget, used as an "empirical ceiling" reference
- [ ] Systems to compare: the **legacy one-shot** approach (reproduced roughly), and **v1 single-shot + repair**.
- [ ] Measures: valid-pipeline rate, locked-test score, score relative to each baseline (normalised 0 = default HGB, 1 = AutoGluon best), $ cost and run time.
- [ ] `benchmarks/report.py` builds a Markdown table and charts for the README.

**Done when:** we have one honest table, whatever the numbers turn out to be.

---

## Phase 3 — The self-evolution loop and ceiling detection (≈3–4 weeks) ⭐ core contribution

### 3.1 The loop (autoresearch adapted to tabular data)

```
baseline = run(unmodified starter solution)        # autoresearch: first run is always baseline
ledger.log(baseline, status="keep")
while not stop_rule.should_stop(ledger):
    idea   = agent.propose(brief, profile, ledger.summary(), memory)   # one hypothesis, stated up front
    patch  = agent.implement(idea, best.solution)
    result = harness.run(patch)                    # sandbox, fixed per-experiment budget
    if result.crashed: result = agent.debug(...)   # ≤ 3 tries, then log "crash" and move on
    decision = gate(result, best)                  # §3.2
    ledger.log(result, decision)                   # keep | discard | crash
    memory.add(idea, outcome)                      # avoid repeating ideas already tried
    if decision == "keep": best = result
final = harness.score_locked_test(best)            # touched exactly once
```

- **Git as the ledger:** each run gets a `evolve/<run-tag>` branch in a worktree. Kept changes are commits and discarded changes are reset, the same as autoresearch. A full history of every experiment also goes in `ledger.jsonl` (the equivalent of `results.tsv`) and the RunRecord.
- **Brief (`brief.md`, our `program.md`):** generated from the profile and the user's description, and editable by the human. It says which libraries are allowed, which file can be edited, the simplicity rule, and any domain hints. Its default contents are maintained by us.
- **Ideas must be stated before they are coded** ("try target encoding for the 3 high-cardinality columns"). That makes the ledger readable and lets us group ideas by type (feature engineering, model family, hyperparameters, ensembling, preprocessing).

### 3.2 Keep/revert gate (where we improve on autoresearch)

autoresearch keeps any change that gives a lower `val_bpb`. On small tabular data, that would mostly keep noise. Our gate:

1. **The improvement must be statistically real on `dev` CV.** Use a paired test across the same folds (e.g. a one-sided paired t-test or bootstrap, p < 0.1), **and** require a mean gain of at least 0.5 × the CV standard error.
2. **It must agree on `select`.** The score on the selection holdout must not get worse. For later work, try a reusable-holdout scheme (Thresholdout-style noise from Dwork et al., 2015) so `select` can be reused across hundreds of decisions without being overfit. That's a good point to discuss in interviews.
3. **Simplicity rule, borrowed from autoresearch:** if the gain is about 0 but the code is simpler (fewer lines or dependencies, faster to fit), keep it. If the gain is tiny but adds a lot of complexity, discard it. Complexity is measured as lines of code plus fit time.

### 3.3 Search strategy (P3a, then P3b)
- **P3a, hill-climbing:** always build on the current best, like autoresearch. Simple and easy to explain.
- **P3b, a tree or islands search when progress stalls:**
  - After N experiments without a keep, branch from the 2nd- or 3rd-best node, or start a "radical" draft from scratch with a different model family. That's ShinkaEvolve's approach of starting a new island when stuck.
  - Use AIDE-style action selection between draft, improve and debug.
  - Add ensembling as an action: stack or blend the top-k kept solutions. This is often where the last gains on tabular data come from.

### 3.4 Ceiling detection: when to stop

Stopping when the budget runs out is the default everywhere else. We stop when **every** one of these is true (and budgets are always a hard limit too):

| Signal | How it's measured | Why |
|---|---|---|
| **Noise floor** | The best score's standard error across repeated CV. Recent "keep" gains are each below that standard error | Further gains can't be told apart from noise |
| **Saturation fit** | Fit `best_score(t) ≈ a − b·exp(−c·t)` (or a power law) to the best score so far against experiment number. The predicted remaining gain `a − current` is below the noise floor | Projects where the curve is heading |
| **Exploration ran out** | At least K "radical" attempts since the last keep (different model family, new feature-engineering approach, ensemble) all failed the gate | Rules out a local optimum that a different approach would escape |
| **External reference (when available)** | Within ε of AutoGluon `best_quality`, or the Kaggle leaderboard or medal threshold (P6), which is MLE-bench's notion of a ceiling | A known ceiling from outside the system |

The output is a **stop report** explaining why it stopped, e.g. "stopped at experiment 143: the last 5 kept gains were each below the CV standard error (0.0021); the fitted curve predicts at most 0.0009 more; 6 radical attempts were rejected." That explanation is the feature people will notice.

User controls: `until="ceiling" | "budget"`, `max_experiments`, `max_hours`, `max_cost_usd`, `patience`.

### 3.5 Measuring overfitting (the experiment the write-up is built on)

For every evolve run, report:
- the `dev` CV score, the `select` score and the **locked-test** score of the final solution
- the **optimism gap**: `select − test`, tracked as the number of experiments grows. This is exactly the criticism autoresearch got, measured directly.
- three ablations:
  - (a) autoresearch-style naive gate (keep any improvement) vs our statistical gate
  - (b) no `select` holdout vs a fixed holdout vs a reusable holdout
  - (c) hill-climbing vs tree search

**Benchmark v1:** rerun the Phase 2 suite with `evolve`. Produce a chart of score against experiment number for each dataset, with baseline lines, and a table of optimism gaps. Also check whether the stopping rule fired close to where the curve actually flattened, looking at runs that were left to continue past the stop.

**Done when:** an overnight evolve run on 15+ datasets finishes on its own, writes a stop report for each dataset, and gives an optimism-gap table comparing our gate with the naive one.

---

## Phase 4 — SDK, CLI and PyPI release (≈1–2 weeks)

```python
from autotabml import AutoTabML

at = AutoTabML(llm="claude-sonnet-5-5", sandbox="local")
run = at.evolve("train.csv", target="price", until="ceiling",
                max_hours=4, max_cost_usd=3, on_event=print)

run.leaderboard          # every experiment: idea, scores, status
run.best.code            # readable solution.py
run.stop_report          # why it stopped
run.test_score           # locked holdout, scored once
run.predict(new_df)
run.export("pipeline/")  # solution.py + fitted model + requirements + report.html
```

- [ ] An event stream (`on_event` callback plus an async iterator) that the CLI and server both use. Event types: `experiment_started`, `llm_call`, `sandbox_output`, `scored`, `decision`, `stopped`.
- [ ] CLI:
  - `autotabml run|evolve <source> --target ...`
  - `autotabml replay run.json`
  - `autotabml report run.json`
  - Live terminal view built with `rich`.
- [ ] `autotabml export` produces a standalone project that doesn't need autotabml to run. "Code you own" is part of the pitch.
- [ ] Docs with mkdocs-material: a quickstart, the harness design, the stopping rule and the benchmark results.
- [ ] Publish to PyPI from GitHub Actions using trusted publishing. The name `autotabml` was confirmed free on 2026-10-06.
- [ ] Optional extras: `autotabml[kaggle]`, `autotabml[docker]`, `autotabml[otel]`, `autotabml[server]`.

**Done when:** `pip install autotabml && autotabml evolve openml:31 --target class` works in a fresh virtual environment.

---

## Phase 5 — Observability UI and hosted demo (≈3 weeks)

**Backend:** a FastAPI app that wraps the SDK and streams events over SSE. Runs are stored in SQLite or Postgres, and artifacts in object storage.

**Frontend (Next.js + Tailwind + a charting library):**
1. **Evolution chart:** best score against experiment number, built live. It shows each kept or discarded experiment as a dot, the noise band (±1 standard error), the fitted saturation curve and baseline lines (HGB, AutoGluon). This is the main view.
2. **Experiment tree:** one node per attempt, coloured keep/discard/crash. Clicking a node shows the idea, the code diff against its parent, the scores for each fold, the error tail and the cost.
3. **Trace timeline:** a waterfall of the spans for each experiment, showing where time and tokens went.
4. **Stop report panel** and the **optimism-gap** readout once the locked test has been scored.
5. **Cost meter:** $ spent, tokens, and cost per kept improvement.

**Demo safety and cost**
- Preloaded datasets (Titanic-like, housing, Adult) with **saved replays** of complete overnight runs, so visitors see the whole evolution for free.
- Live runs: users bring their own LLM key **or** use our key with strict limits (e.g. 10 experiments, $0.20, one live run per IP per day).
- Generated code runs in e2b or Modal sandboxes only, never in the web server process.
- Uploads are kept per session, encrypted, and deleted after 24h. Nothing is shared between users.

**Done when:** a public URL where someone can watch a replay in 10 seconds or start a small live run in about 2 minutes.

---

## Phase 6 — Kaggle integration (≈2 weeks, further enhancement)

### 6.1 How users connect (from research on 2026-10-06)
- **Local CLI/SDK (do first):** use `kagglehub` with the user's own credentials. Supported methods: `kagglehub.login()`, the `KAGGLE_API_TOKEN` env var, or `~/.kaggle/access_token`. New tokens start with `KGAT`, and the legacy `kaggle.json` still works. Nothing passes through us.
- **Hosted app:** Kaggle does run an OAuth 2.0 provider (authorization code + PKCE, with scopes for datasets and competitions). However, **you have to contact the Kaggle team to get a client ID; there's no self-serve registration**, and public clients may only redirect to localhost.
  - Plan A: apply for an OAuth client early, because approval takes an unknown amount of time.
  - Plan B, until it's approved: the user pastes a token. Encrypt it at rest, make it revocable from the UI, use it only for that user's requests, and never log it.

### 6.2 Features
- [ ] `KaggleSource("owner/dataset")` downloads with `kagglehub.dataset_download` (cached under `~/.cache/kagglehub/`).
- [ ] Dataset search inside the UI and CLI through the Kaggle API: filter by file type, size and license, and read the license from the dataset metadata.
- [ ] **Show the license before use**, and never cache or serve one user's Kaggle data to another user.
- [ ] **Competitions:** `KaggleSource("competition:<slug>")` downloads with `kagglehub.competition_download`.
  - If the user hasn't accepted the competition rules, Kaggle returns a **403** (there's no API to accept them). Detect it and show a "Accept the rules at kaggle.com/c/<slug>/rules, then retry" message.
  - Map the competition's evaluation metric to our metric, or fall back with a warning.
- [ ] **Optional submission** (`kaggle competitions submit`, then poll for the score):
  - Respect the daily submission limit (usually 5 per day, but it varies by competition).
  - Show an explicit confirmation before each submission.
  - Use the public leaderboard score as the **external ceiling signal** for §3.4, and the leaderboard's medal thresholds as targets, the same way MLE-bench does.
  - Use the official API only, never scraping (Kaggle's terms ban crawling).

### 6.3 Data assembly (stretch)
- [ ] Let the agent suggest **joining extra public datasets** to enrich features (e.g. adding a geographic lookup to housing data).
  - The user approves each join.
  - The license is checked.
  - The harness checks the join for leakage: the join key must not encode the target, and coverage is checked.

**Done when:** `autotabml evolve kaggle:competition:<slug>` downloads the data, evolves a solution until it hits the ceiling, and (with confirmation) submits and reports the public leaderboard score.

---

## Phase 7 — Write-up and launch (≈1 week)

- [ ] **Technical report or blog post:** "Autoresearch for tabular ML: when should a self-improving agent stop?" Cover the benchmark, the optimism-gap ablations, the stopping rule's accuracy, and failure categories drawn from the traces (cluster failed attempts into categories, fix the top 3, report the change in success rate).
- [ ] README: a GIF of the evolution chart, the benchmark table, a 3-line quickstart, an architecture diagram.
- [ ] A 2-minute demo video.
- [ ] Post on HN or Reddit (r/MachineLearning), mention autoresearch, and submit a PR to "awesome-autoresearch"-style lists.

---

## 8. Resume bullets this plan aims to earn (fill in real numbers)

- Built **AutoTabML**, an open-source self-improving agent for tabular ML (autoresearch-style loop). It keeps or reverts changes using paired statistical tests and **stops on its own at a detected performance ceiling**. Reached **X%** of AutoGluon's score on **N** OpenML datasets with readable, exportable code at **$Y** per run.
- Measured validation overfitting in self-improving agent loops. Using a statistical keep/revert gate and a separate selection holdout cut the select-to-test optimism gap by **Z%** compared with an autoresearch-style naive gate.
- Shipped it as a PyPI SDK and CLI with OpenTelemetry-native tracing, plus a hosted UI that streams each run's live evolution chart, experiment tree and cost.
- Added Kaggle integration (dataset and competition download, license checks, optional submission). The leaderboard score serves as an external ceiling signal.

## 9. Interview questions to rehearse

1. Why not just use AutoGluon? *(Readable code you own, explainable steps, and the research question about when to stop. Be honest that AutoGluon often wins on raw score.)*
2. How do you know a "kept" change is a real improvement? *(Paired CV test plus agreement on the selection set.)*
3. How do you keep hundreds of keep/revert decisions from overfitting the holdout? *(Separate selection and locked test sets, reusable holdout, the optimism-gap measurements.)*
4. Explain the stopping rule. When does it fail? *(Curves that are flat for a long time and then jump; noisy small datasets.)*
5. What can escape your sandbox? *(Be specific about the threat model for each backend.)*
6. Why one agent and not many?
7. What did the traces teach you? *(The failure categories and the fixes they led to.)*

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| LLM cost of overnight runs | Use a cheap model for implement/debug and a strong one for propose. Track cost in the ledger. Set `max_cost_usd` |
| Gains are mostly hyperparameter tweaks (boring) | Group ideas by type in memory; push "radical" exploration when progress stalls |
| The stopping rule fires too early or too late | Validate it by letting runs continue past the stop (Phase 3.5) and report how accurate it is |
| Scope creep in the UI | The UI is a client of SDK events only; build nothing in the UI that the CLI can't do |
| Kaggle OAuth approval delay | Pasted token as plan B; local CLI works from day one |
| Comparisons to autoresearch feel derivative | Lead with what's new: the tabular domain, the statistical gate, the ceiling detection and the overfitting measurements |

## 11. References
- karpathy/autoresearch — https://github.com/karpathy/autoresearch (`program.md`, `prepare.py`, `train.py`)
- SkyPilot, scaling autoresearch (910 experiments, phases of diminishing returns) — https://skypilot.ai/blog/scaling-autoresearch/
- AIDE — https://github.com/WecoAI/aideml · https://arxiv.org/abs/2502.13138
- MLE-bench — https://arxiv.org/abs/2410.07095
- R&D-Agent — https://github.com/microsoft/RD-Agent
- OpenEvolve — https://huggingface.co/blog/codelion/openevolve · ShinkaEvolve — https://github.com/SakanaAI/ShinkaEvolve
- Kaggle API / kagglehub — https://github.com/Kaggle/kagglehub · https://github.com/Kaggle/kaggle-api/blob/main/docs/README.md
- Dwork et al., "The reusable holdout" (Science, 2015)
- OpenML — https://docs.openml.org
