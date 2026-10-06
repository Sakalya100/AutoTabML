# AutoTabML web

The hosted demo and observability UI for AutoTabML v2: watch a recorded run evolve, or upload a CSV and watch a live one. One Next.js (App Router) project; its route handlers are the backend. The Python engine always runs **out of process** through a pluggable runner. The UI is only a client of the engine's JSONL event stream (`src/autotabml/obs/events.py`).

## Develop

```bash
cd web
npm install
npm run dev            # http://localhost:3000
```

Replays work with nothing else installed. Live runs use the **local runner**, which needs [`uv`](https://docs.astral.sh/uv/) and the Python package in the repo root (`uv sync` there once). The runner spawns:

```
uv run --project <repo root> python -m autotabml evolve <csv> --target <t> --llm <spec> \
  --max-experiments N --max-cost <usd> --out web/.data/runs/<id>/out --events-stdout [--description …]
```

and stores stdout events in `web/.data/runs/<id>/events.jsonl`. Override the command with `AUTOTABML_PYTHON_CMD`. To work on the UI without Python, set `AUTOTABML_PYTHON_CMD="node scripts/fake-engine.mjs"`. It replays the hand-written fixture in `scripts/fixtures/` as if it were live. **It is not the engine.**

| script | what it does |
|---|---|
| `npm run lint` / `npm run typecheck` / `npm run build` | ESLint, `tsc --noEmit`, production build |
| `npm test` | vitest: event parsing, metric orientation, stores, upload validation, run-state reducer |
| `npm run gen:types` | regenerate `src/lib/schema.ts` from `../schema/*.schema.json` (run after `python -m autotabml.obs.schema`) |
| `npm run validate:replays` | validate `public/replays/*` against the JSON Schemas (ajv) plus cross-file checks |
| `node scripts/make-fixture-replay.mjs` | rebuild the hand-written iris fixture replay |

### Adding a real replay

From the repo root: `uv run python benchmarks/export_replays.py runs/<run-dir>:<name> ...` copies `run.json` and `events.jsonl` into `public/replays/<name>/` and rebuilds `public/replays/index.json`. Then run `npm run validate:replays`. All bundled replays are real engine runs. The hand-written `scripts/fixtures/iris-heuristic` exists only for `fake-engine.mjs` and the unit tests.

## API

| route | |
|---|---|
| `POST /api/runs` | multipart: `file` (CSV ≤ 5 MB), `target`, `description`, `maxExperiments` (≤ 30), `llm` = `heuristic` \| `anthropic`. BYOK key in the `x-anthropic-api-key` header. Rate-limited per IP |
| `GET /api/runs/:id` | meta + events (`?after=<seq>`) + `record` (run.json) once written |
| `GET /api/runs/:id/stream` | SSE: replays stored events, then tails the store. Supports `Last-Event-ID`. Sends `event: meta` and `event: end` |
| `POST /api/runs/:id/cancel` | kills the process group (local) or stops the sandbox |
| `POST /api/runs/:id/ingest` | event ingest for the vercel-sandbox runner (per-run bearer token) |
| `GET /api/replays` | bundled replays |

**Secrets:** a BYOK key goes into the engine's environment for that run only (local runner). On Vercel Sandbox, the firewall injects it as a header, so it never enters the VM. It is never written to the store or to logs. Stderr is redacted before it is logged or shown.

## Deploy (Vercel)

- **Root Directory:** `web`. Framework preset: Next.js.
- **Store:** set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. The file store does not work on serverless.
- **Runner:** `vercel-sandbox` is chosen automatically on Vercel. Set `AUTOTABML_PUBLIC_URL` (where the sandbox posts events) and optionally `AUTOTABML_SANDBOX_PACKAGE` (defaults to the GitHub `v2` branch). Deployment Protection must let the sandbox reach `/api/runs/*/ingest`.
- **Replays-only demo:** set `AUTOTABML_LIVE_RUNS=0`.
- **Limits:** Vercel Sandbox sessions run for at most 45 min on Hobby and 24 h on Pro/Enterprise (`AUTOTABML_SANDBOX_TIMEOUT_MS`, default 45 min). Each vCPU comes with 2 GB of RAM. The per-IP rate limit is in memory and applies per function instance, so move it to Redis before relying on it.

See `.env.example` for every variable.

### Status

- **Verified locally:** local runner + file store against the real engine (heuristic proposer), SSE live tailing, cancel, validation errors, rate limit, and that BYOK keys don't leak.
- **Untested:** the `vercel-sandbox` runner (`src/lib/runner/vercel-sandbox.ts`) and the ingest route end to end, as well as `RedisStore` (`src/lib/store/redis-store.ts`). They follow the current `@vercel/sandbox` 3.x API and the Upstash REST protocol, but no credentials were available to run them.
