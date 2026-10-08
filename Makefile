# Local development: the FastAPI backend and the Next.js frontend together.
#   make dev                 backend on :$(API_PORT), frontend on :3000 (Ctrl-C stops both)
#   make dev API_PORT=8001   if :8000 is taken
#   make migrate             apply backend/migrations to DATABASE_URL (repo-root .env)
#   make test                engine + backend + web checks
API_PORT ?= 8000

.PHONY: dev api web migrate test

dev:
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) --no-print-directory api & \
	$(MAKE) --no-print-directory web & \
	wait

# No --reload: a reload would orphan the local runner's engine processes and their stdout readers.
api:
	uv run --project backend uvicorn backend.main:app --host 127.0.0.1 --port $(API_PORT)

web:
	cd web && AUTOTINKER_API_URL=http://127.0.0.1:$(API_PORT) npm run dev

migrate:
	uv run --project backend python -m backend.migrate --list

test:
	uv run pytest -q && uv run ruff check src tests benchmarks && uv run mypy
	cd backend && uv run pytest -q && uv run ruff check . && uv run mypy
	cd web && npm run lint && npm run typecheck && npm test && npm run validate:replays
