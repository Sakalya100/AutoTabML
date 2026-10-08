-- The FastAPI backend: Postgres is now the only run store (live tailing and durable history), so the run row
-- carries what the file/Redis store used to hold. Plus fixed-window rate-limit counters and small app settings
-- (the reusable sandbox snapshot id).

alter table runs drop constraint if exists runs_status_check;
alter table runs add constraint runs_status_check
  check (status in ('queued', 'starting', 'running', 'finished', 'failed', 'cancelled', 'timed_out'));

alter table runs
  -- 'local' (a process on the API host) or 'sandbox' (Vercel Sandbox)
  add column if not exists runner        text not null default 'local',
  -- 'url' (the engine downloads source_url) or 'file' (an uploaded CSV)
  add column if not exists source        text not null default 'url',
  add column if not exists file_bytes    bigint not null default 0,
  add column if not exists updated_at    timestamptz not null default now(),
  -- short, user-safe failure message, and the redacted tail of the engine's stderr
  add column if not exists error         text,
  add column if not exists error_tail    text,
  -- the engine's run.json once it has written it
  add column if not exists record        jsonb,
  -- sandbox name, or the local process group id
  add column if not exists runner_ref    text,
  -- sha256 of the per-run token the sandbox posts events with (the token itself is never stored)
  add column if not exists ingest_token_sha256 text,
  -- watchdog: last event or heartbeat, and the hard deadline
  add column if not exists last_seen_at  timestamptz,
  add column if not exists deadline_at   timestamptz,
  -- startup timings (sandbox create / install or snapshot restore / start), for the logs and tuning
  add column if not exists timings       jsonb not null default '{}'::jsonb;

-- non-terminal runs, for the watchdog sweep
create index if not exists runs_active_idx on runs (status) where status in ('queued', 'starting', 'running');

create table if not exists rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (key, window_start)
);

create table if not exists app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
