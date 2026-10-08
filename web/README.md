# AutoTinker web

The hosted demo and observability UI for AutoTinker v2: watch a recorded run evolve, or paste a link to a CSV and
watch a live agentic run in a session. This is a **frontend-only** Next.js (App Router) app. The API is the FastAPI
service in [`../backend`](../backend), and the Python engine always runs out of process (a local child process in dev,
a Vercel Sandbox microVM in production). The UI is only a client of the engine's JSONL event stream
(`src/autotinker/obs/events.py`), relayed by the backend over SSE.

## Develop

From the repo root, once: `uv sync` (the engine), `uv sync --project backend` (the API), `cd web && npm install`.
The backend needs a Postgres: the repo-root `.env` `DATABASE_URL*` (Neon), or any local one, then `make migrate`.

```bash
make dev                  # backend on :8000 + next dev on :3000 (Ctrl-C stops both)
make dev API_PORT=8001    # if :8000 is taken
```

or by hand, in two terminals:

```bash
uv run --project backend uvicorn backend.main:app --port 8000      # repo root; no --reload (see the Makefile)
cd web && AUTOTINKER_API_URL=http://127.0.0.1:8000 npm run dev
```

In `next dev`, `next.config.ts` rewrites `/api/*` to `AUTOTINKER_API_URL` (dev only). On Vercel the root
`vercel.json` routes `/api/*` to the backend service, so the browser always calls same-origin `/api/*`.

Replays need nothing but the frontend. Live runs use the backend's **local runner**, which spawns
`uv run --project <repo root> python -m autotinker run <link> --target … --events-stdout --control-file …`
(override with `AUTOTINKER_PYTHON_CMD`). To work on the UI without Python, start the backend with
`AUTOTINKER_PYTHON_CMD="node web/scripts/fake-engine.mjs"`: it replays the hand-written fixture in
`scripts/fixtures/` as if it were live. **It is not the engine.**

| script | what it does |
|---|---|
| `npm run lint` / `npm run typecheck` / `npm run build` | ESLint, `tsc --noEmit`, production build |
| `npm test` | vitest: event parsing, run-state/feed/chat reducers, CSV parsing + suggestion heuristics, upload validation |
| `npm run gen:types` | regenerate `src/lib/schema.ts` from `../schema/*.schema.json` (run after `python -m autotinker.obs.schema`) |
| `npm run validate:replays` | validate `public/replays/*` against the JSON Schemas (ajv) plus cross-file checks |
| `node scripts/make-fixture-replay.mjs` | rebuild the hand-written iris fixture replay |

### Adding a real replay

From the repo root: `uv run python benchmarks/export_replays.py runs/<run-dir>:<name> ...` copies `run.json` and
`events.jsonl` into `public/replays/<name>/` and rebuilds `public/replays/index.json`. Then run
`npm run validate:replays`. Replays are static files served from `public/replays`; the pages read them at render time.

## API (served by the backend)

| route | |
|---|---|
| `GET /api/sessions` · `GET/PATCH /api/sessions/:id` | your sessions; one session with its messages and every run's events; rename |
| `POST /api/sessions/:id/messages` | `{text}` or `{kind: "stop"}`: chat, steer the Planner, or stop gracefully |
| `POST /api/preview` | `{url, goal?}`: SSRF-guarded preview of a public CSV link + target/metric suggestion |
| `POST /api/runs` | JSON `{url, target, metric?, goal?, maxExperiments, sessionId?, sentence?}` or multipart with `file` (≤ 5 MB) |
| `GET /api/runs/:id` | meta + events (`?after=<seq>`) + `record` (run.json) once written |
| `GET /api/runs/:id/stream` | SSE: stored events, then live ones; `Last-Event-ID` resume; `event: meta` / `event: end`; ≤ 280 s per connection |
| `POST /api/runs/:id/cancel` | hard stop (process group / sandbox) |
| `POST /api/runs/:id/ingest` | the sandbox forwarder's event ingest (per-run token) |

Identity is an anonymous signed `at_owner` cookie minted by the backend; every session/run route checks ownership.
See [`../backend/.env.example`](../backend/.env.example) for configuration and limits.
