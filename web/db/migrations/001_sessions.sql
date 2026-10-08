-- Phase 3: durable sessions (docs/AGENTIC_PLAN.md §6).
-- Anonymous owners (signed cookie) -> sessions -> runs -> run_events, plus the chat messages of a session.
-- Live tailing stays in the file/Redis store; every event is also written here (idempotent on (run_id, seq)).

create table if not exists owners (
  id         text primary key,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id          text primary key,
  owner_id    text not null references owners (id) on delete cascade,
  title       text not null default 'New session',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  last_run_id text
);

-- owner -> sessions, newest first (the sessions list)
create index if not exists sessions_owner_updated_idx on sessions (owner_id, updated_at desc);

create table if not exists runs (
  id              text primary key,
  session_id      text not null references sessions (id) on delete cascade,
  status          text not null default 'queued'
                  check (status in ('queued', 'starting', 'running', 'finished', 'failed', 'cancelled')),
  source_url      text,
  file_name       text,
  target          text not null,
  metric          text,
  goal            text not null default '',
  max_experiments integer not null check (max_experiments > 0),
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  -- best dev-CV mean so far, oriented (higher is better; see Metric.to_raw for display)
  best            double precision,
  -- {final, stop, report, error} as they arrive; never secrets
  summary         jsonb not null default '{}'::jsonb
);

create index if not exists runs_session_created_idx on runs (session_id, created_at);

create table if not exists run_events (
  run_id  text not null references runs (id) on delete cascade,
  seq     integer not null,
  type    text not null,
  payload jsonb not null,
  ts      timestamptz not null,
  -- also the run -> events index (range scans by seq)
  primary key (run_id, seq)
);

create table if not exists messages (
  id         text primary key,
  session_id text not null references sessions (id) on delete cascade,
  run_id     text references runs (id) on delete set null,
  role       text not null check (role in ('user', 'system')),
  text       text not null check (length(text) <= 4000),
  kind       text not null default 'chat' check (kind in ('chat', 'steer', 'control')),
  created_at timestamptz not null default now()
);

create index if not exists messages_session_created_idx on messages (session_id, created_at);
