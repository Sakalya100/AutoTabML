# AutoTinker — Product Roadmap

> **Where we're going:** give AutoTinker a dataset and get back the best model you can actually **defend and use**: cleaned data, a model that beats strong baselines by a margin that holds up on data it never saw, a plain-language account of what was tried and why, and a way to put the model to work and keep it honest over time.

Status: active · Written 2026-10-09 · Replaces the v2 build plan ([BUILD_PLAN_v2.md](BUILD_PLAN_v2.md), mostly shipped)

---

## 0. Where we are (2026-10-09)

**Shipped:**
- **Engine:**
  - Sandboxed harness with a frozen dev / select / locked-test split.
  - Corrected paired t-test gate and four-signal ceiling stop.
  - Agent roles: intake, profiler, planner, coder, critic, judge, tuner, ensembler, reporter.
  - Free Groq / Gemini routing; data rows never sent to Gemini.
  - Run assets: locked-test charts, `model.joblib`, `pipeline.py`.
- **Web:**
  - Paste-a-link setup pane, live chat-style run feed (timeline cards), 3D map, assets panel.
  - Steering and stopping mid-run.
  - Clerk sign-in, dark UI.
- **Infrastructure:**
  - FastAPI + Next.js as two Vercel services.
  - Runs in Vercel Sandbox; Neon Postgres for state.
  - Private Vercel Blob for model files.
  - Live at autotinker.sakalya.si.

**What an audit on 2026-10-09 found** (first-time-user walkthrough, market scan, code review):
1. **Trust bugs a first-time user hits.**
   - The engine re-parses CSVs differently from the preview (semicolon files fail as "exit code 2").
   - `pipeline.py` isn't runnable on its own.
   - Some verdict labels contradict the numbers ("NEW BEST" on a lower score; raw negative scores leak).
   - Nonsense targets (IDs, names) and 20-row datasets start without warning.
2. **Results are a dead end.**
   - No way to predict on new data.
   - No sense of whether a score is good (no baseline, no verdict).
   - The report reads like a log.
3. **The core claim is unproven.** The only benchmark used the offline heuristic proposer, one seed and five tiny datasets, and the gate didn't beat a naive gate.
4. **The market moved.**
   - Pre-trained tabular models (TabPFN-2.5/3, TabICLv2, NVIDIA Kumo Tabular) beat tuned gradient boosting on small tables in seconds.
   - Plexe (YC X25) ships prompt-to-deployed-model; Julius, Colab's Data Science Agent, and the Databricks and Snowflake agents cover casual analysis.

## 1. Positioning

**"The AI data scientist you can audit."** Every claimed improvement comes with evidence, every rejected idea with a reason, and one honest number for how good the model really is.

Why this is defensible:
- **AI agents grade their own homework.** Published work finds agents tamper with editable evaluators in about half of runs ([RewardHackingAgents, 2026](https://arxiv.org/html/2603.11337)).
- **AutoML is a "double black box"** that users don't trust ([CHI '23](https://arxiv.org/html/2302.10827v3)).
- **AutoTinker's design is the published defence:** a locked test, scoring code the agent can't touch, a sandbox, and a statistical gate.

We don't compete on raw accuracy alone. We start from the strongest baseline available and prove, or honestly fail to prove, that the agents improved on it.

**Who it's for first:** analysts and students who must defend a model to someone else (a manager, a teacher, a reviewer), and Kaggle beginners. Not enterprises yet.

## 2. Principles

- **Never claim a gain that isn't real.** Every new feature (cleaning, retraining, feature engineering) goes through the same gate and the same locked test.
- **The user owns the output:** readable code, a portable model, an exportable record. No lock-in.
- **Plain language first, numbers on demand.** Say "good / okay / weak" before the p-value.
- **Fail loudly and helpfully.** No "exit code 2". Every failure says what happened and what to do next.
- **Free to try.** Keep a generous free tier on free models; paid power is optional.

## 3. Phases at a glance

| Phase | Theme | Effort (part-time) | Done when |
|---|---|---|---|
| 1 | Trust fixes and first-run polish | 1–2 weeks | A stranger can go link → run → result with no dead ends; `pip install autotinker` works |
| 2 | Strong baselines and results people can read | 2–3 weeks | Every run starts from a pre-trained-model baseline and ends with a verdict a non-expert understands |
| 3 | Proof: benchmark v1 | 2 weeks | A published table vs AutoGluon and the baseline, with a "fooled-itself rate", on 20–30 datasets × 3 seeds |
| 4 | Use the model | 2–3 weeks | Upload new rows → predictions; one-click export that runs anywhere; public share links |
| 5 | Data in: connectors, cleaning, leakage | 3–4 weeks | Sheets / Excel / Postgres in; a cleaning and leakage agent whose fixes are approved and gated |
| 6 | Model lifecycle | 3–4 weeks | Versioned models, a hosted prediction API, drift monitoring, retraining that ships only if the gain is real |
| 7 | Time series forecasting | 3–4 weeks | Forecasts with intervals on time-ordered validation, gated like everything else |
| 8 | Text and images as columns | 2–3 weeks | Text and image-URL columns become features via pre-trained embeddings |
| 9 | Teams, privacy, scale | ongoing | Workspaces, schema-only privacy mode, bring-your-own-key, bigger budgets |

Order rationale:
- **Phases 1–3 make the existing promise true and provable.** Nothing after them matters if a first run dead-ends or the core claim is unproven.
- **Phases 4–6 cover the before and after of modelling.** That's where "one-stop" really lives: modelling is only 10–20% of the work.
- **Phases 7–8 add data types**, in order of fit with the trust machinery.

---

## Phase 1 — Trust fixes and first-run polish (1–2 weeks)

**Why:** each of these silently costs a first-time user before any strength is visible.

- **One parser for preview and engine.**
  - Send the detected delimiter, encoding and header (or the already-normalised file) from the preview to the engine.
  - Add tests with semicolon, tab, Latin-1 and BOM files.
  - Turn engine exit codes into plain messages, with a **Retry** and an **Edit setup** button.
- **Setup guard-rails**, using what the profiler already knows:
  - Block ID-like and free-text targets, explaining why.
  - Warn on fewer than about 100 rows (and suggest fewer experiments), on more than 50 classes, and on heavy imbalance.
  - Show an estimated time before Start, e.g. "≈ 4–6 min for 10 experiments", and an ETA during the run.
- **Make verdicts consistent.**
  - Find out why "NEW BEST" can sit on a lower score: the gate decides on the oriented paired test plus the select holdout, which the UI doesn't explain.
  - Either fix the label or show the reason ("kept: better on the selection holdout, within noise on CV").
  - Never display oriented (negated) scores.
- **Make `pipeline.py` runnable on its own:** a `predict.py` that loads `model.joblib` and handles column order, dtypes and label decoding. Decode predictions back to the original labels (today the model predicts 0..k−1).
- **Fix the first impressions.**
  - Hero copy that says what it is: "Paste a CSV link. AI agents build and test a prediction model, and tell you honestly how good it is."
  - CTA "Try it on your data".
  - After sign-in, land in the workspace; add a "My sessions" link in the header.
  - Fix the error copy for uploads, and give Google Sheets links a readable name.
- **Developer path.**
  - Publish `autotinker` 0.1 to PyPI.
  - README covers `pip install`, the `run` (agentic) command, one consistent LLM story (Groq/Gemini free by default, Anthropic/OpenAI optional) and a link to the live site.
  - Update the GitHub description and homepage.
- **Agent-powered replays.** Re-record the public replays with the agents. All four were recorded with the offline proposer, so the showcase doesn't show the product.

**Done when:** a stranger with a European CSV, an ID-like target or a tiny file gets a helpful message rather than a dead end. The downloaded `predict.py` runs on new rows. `pip install autotinker && autotinker run …` works from the README.

## Phase 2 — Strong baselines and results people can read (2–3 weeks)

**Why:** pre-trained tabular models changed what "a good model" means. The agents must start from the best known baseline and add value on top, or say honestly that they can't.

- **Experiment zero is a strong baseline set**, run before any agent idea:
  - a naive baseline (majority class / mean);
  - gradient boosting with good defaults;
  - a pre-trained tabular model, using one whose licence allows product use (TabICLv2 or NVIDIA Kumo Tabular; TabPFN-3's open weights are non-commercial). It has to fit the sandbox's CPU and memory, so check runtime on the current sandbox size (2 vCPU / 4 GB).

  The best of these becomes the incumbent the gate compares against.
- **Every number gets context.**
  - "vs predicting the average: 38% lower error".
  - A good / okay / weak verdict per task and metric.
  - "The agents beat the pre-trained baseline by X (holds up on unseen data)" or "couldn't beat it: here's why that's fine".
- **A plain-language report.**
  - Rewrite the reporter prompt and template around three questions: what you can expect on new data, what made the difference, and what was tried and didn't help.
  - Round numbers sensibly; no token counts or raw decimals in prose.
  - Hide crash-and-repair noise behind Details.
- **Explanations.**
  - Global feature importance (permutation importance on the locked test, as an asset chart).
  - Per-row "why" for a sample of predictions (SHAP or similar when the model supports it).
- **Thresholds and calibration** for classifiers: a calibration chart and a threshold picker ("at 0.37 you catch 80% of churners and flag 12% of customers").
- **Fairness slice**, optional: accuracy by a user-chosen column (e.g. by region or gender) as an asset.

**Done when:** every run shows baseline → incumbent → final with the margin and a verdict. The report reads like a short memo. Classifiers come with a threshold picker.

## Phase 3 — Proof: benchmark v1 (2 weeks)

**Why:** "you can trust the gains" is the headline, and today it's unproven. This is also the thing interviewers and investors ask first.

- **Suite:** 20–30 OpenML / TabArena datasets (classification and regression, 500–50k rows), 3 seeds each.
- **Systems compared:**
  - AutoGluon (medium and best quality);
  - the pre-trained baseline alone;
  - AutoTinker with the naive gate;
  - AutoTinker with the statistical gate;
  - AutoTinker with ceiling stopping.
- **Metrics:**
  - locked-test score;
  - wall time and equivalent cost;
  - **fooled-itself rate**: the share of claimed improvements that don't hold on the locked test;
  - optimism gap distribution;
  - how close the stop came to where the curve actually flattened.
- **Publication:** a public results page plus `benchmarks/results/v1.md`, a short write-up, and charts.

  If the gate still doesn't win on accuracy, say so, and lead with the fooled-itself rate and the cost saved by stopping early.

**Done when:** the README's benchmark table is replaced with v1, and the claims in this roadmap's Positioning section are backed by numbers (or revised).

## Phase 4 — Use the model (2–3 weeks)

**Why:** a score with no way to use it is a dead end. This is the most-requested missing piece.

- **Predict in the app:** upload or paste rows (CSV / Sheets) and download predictions with probabilities and the "why" columns. Runs in a sandbox against `model.joblib`.
- **One-click export**, a zip with:
  - `predict.py` and `requirements.txt` with pinned scikit-learn;
  - an optional Dockerfile and a tiny FastAPI server;
  - an optional ONNX file where conversion works;
  - the model card and run record.

  This is the web counterpart of the SDK's `run.export()`.
- **Public share links:** a read-only page per run (task, verdict, what was tried and rejected, charts) with no data rows. Owners can revoke it. This doubles as distribution.
- **Compare, rerun, extend:**
  - compare two runs side by side;
  - "continue with 10 more experiments" from the incumbent;
  - rerun on an updated file.

**Done when:** a user can go dataset → model → predictions on new rows without leaving the app or writing code, and can hand someone a link that explains the model.

## Phase 5 — Data in: connectors, cleaning, leakage (3–4 weeks)

**Why:** most real data isn't a clean single CSV, and leakage is the most common way models lie. An honesty-first product should catch it.

- **More inputs.** Files: Excel, Parquet, JSON, zipped CSVs. Then live connectors, in this order:
  1. Google Sheets (live, not one-off export);
  2. Postgres;
  3. BigQuery;
  4. Snowflake;
  5. S3.

  Credentials go in a vault and never reach the agents.
- **Multi-table:** several files or tables with a proposed join and aggregates (customers + orders → "orders in the last 90 days"). The user approves the join; the features go through the gate.
- **Cleaning agent with an audit trail.**
  - Proposes fixes: duplicates, mixed types, impossible values, unit mismatches, messy categories, date parsing.
  - The user approves or rejects each one; approved fixes become part of `pipeline.py`, and the gate measures their effect.
- **Leakage detector.** Flags columns that "know the answer":
  - near-perfect single-column predictors;
  - columns recorded after the outcome (timestamp heuristics);
  - target-derived columns;
  - IDs that encode time.

  The user decides; the report records the decision.
- **Framing assistant.** From a goal ("reduce churn"), it proposes a target, population, time cut-off and a metric tied to costs ("a missed churner costs $X, a false alarm $Y").

**Done when:** a user can connect a Sheet or a Postgres table, see and approve cleaning and leakage findings, and every accepted change shows up in the code and the report.

## Phase 6 — Model lifecycle (3–4 weeks)

**Why:** a model's value is realised after the run. "Only ship a retrained model if the improvement is real" is a feature nobody else sells.

- **Versions and lineage:** every model tied to its data snapshot hash, code, run, test score and model card. Roll back and compare versions.
- **Hosted prediction API:** a per-model endpoint with API keys, rate limits and usage logs, with a Sheets add-on (`=AUTOTINKER_PREDICT(...)`) on top.
- **Monitoring:**
  - input drift (population stability on key features, new categories, missing-rate jumps);
  - prediction drift;
  - accuracy once real outcomes arrive (upload or connector).

  Alerts by email.
- **Gated retraining:** scheduled or drift-triggered. The candidate must beat the live model through the same statistical gate on fresh data before it's promoted; otherwise the report says why it wasn't.

**Done when:** a model can be served, watched and retrained on a schedule, and no promotion happens without evidence.

## Phase 7 — Time series forecasting (3–4 weeks)

**Why:** demand and sales forecasting is huge, it's still tabular, and the statistical machinery carries over.

- **Problem type `forecast`:**
  - single and many series;
  - forecast horizon;
  - known future inputs (promotions, holidays);
  - the calendar.
- **Validation without peeking:** rolling-origin, time-ordered, never shuffled. The locked test is the final period.
- **Baselines:** seasonal naive, ETS / ARIMA via statsforecast, gradient boosting on lag features, and a pre-trained time-series model if a suitable licence exists.
- **Outputs:**
  - forecast intervals, not just point forecasts;
  - a backtest chart;
  - a per-series accuracy table.
- **Gate and stop rule adapted** for dependence between periods: block-wise comparisons, and a paired test over origins.

**Done when:** a sales CSV with a date column produces gated forecasts with intervals, and the report explains the backtest.

## Phase 8 — Text and images as columns (2–3 weeks)

**Why:** real tables have descriptions, reviews and photo URLs. Turning them into numbers (embeddings) with pre-trained models adds signal without GPU training.

- Text columns become sentence embeddings (CPU-friendly models) or TF-IDF, as features the agents can choose. The gate decides whether they help.
- Image-URL columns become image embeddings from a small pre-trained model, cached per dataset.
- **Deferred, maybe never:** standalone image classification and NLP fine-tuning. They need GPUs, compete with Roboflow and Hugging Face AutoTrain, and dilute the positioning unless the trust layer carries over clearly.

**Done when:** a product-listing table with a description and an image URL gets features from both, and the report says whether they helped.

## Phase 9 — Teams, privacy, scale (ongoing)

- **Workspaces:** shared sessions, comments, roles, and an approval step before deployment.
- **Privacy modes:**
  - **Schema-only:** no data rows sent to any LLM; agents see only names, types and statistics.
  - **Bring your own key:** OpenAI, Anthropic, or a self-hosted model.
  - **Self-host:** Docker Compose for the API and runner.
- **Scale:**
  - larger budgets and longer runs ("until the ceiling" with a price estimate);
  - bigger files via direct-to-Blob upload;
  - optional stronger models for the planner.
- **Paid tier**, only after Phase 4 has real users: higher limits, the hosted API and monitoring. Keep the free tier generous.

---

## 4. Metrics to track

- **Activation:** visitors who start a run → runs that reach a result (target > 85%, up from failures like exit code 2).
- **Usefulness:** results with a prediction or export within 7 days; share-link views.
- **Return:** users with a second run within 14 days.
- **Trust:**
  - fooled-itself rate in benchmarks and in production (where a later locked test exists);
  - the share of runs where agents beat the baseline, and by how much.
- **Cost:** equivalent cost per run; free-tier quota exhaustion events.

## 5. Not building (for now)

- A notebook or IDE: Hex, Deepnote and Colab own that.
- General chat-with-your-data analytics: Julius and ChatGPT own that. We answer "build me a model I can trust", not "make me a chart".
- Enterprise MLOps and governance suites (DataRobot territory) before there are real users.
- Training deep models on GPUs.

## 6. Risks and open questions

| Risk | Mitigation |
|---|---|
| Pre-trained tabular models make agent search pointless on small data | They become the baseline (Phase 2); the agents' value shifts to cleaning, leakage, framing and proof, not raw accuracy |
| Free LLM tiers are weak and rate-limited (Groq daily caps) | Strong deterministic baselines first; schema-only prompts; optional bring-your-own key; cache plans across similar datasets |
| The gate still doesn't beat a naive gate on accuracy (Phase 3) | Lead with the fooled-itself rate and cost saved; publish honestly; revise positioning |
| Licences: TabPFN-3 open weights are non-commercial | Use TabICLv2 / Kumo Tabular; keep the baseline pluggable |
| Vercel limits (4.5 MB bodies, 45-min sandbox on Hobby, 300 s functions) | Direct-to-Blob uploads (done for assets); chunked runs; move to Pro or containers when needed |
| Privacy expectations for business data | Schema-only mode, self-host, a clear policy ([/privacy](https://autotinker.sakalya.si/privacy)) |
| Direct competitors (Plexe, the Databricks and Snowflake agents) | Out-position on auditability and owned output; meet users where they are (Sheets first) |
