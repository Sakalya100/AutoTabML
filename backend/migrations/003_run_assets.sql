-- Downloadable files a run produced after its locked test (the trained model, the pipeline code): one row per file.
-- The engine announces them in its `assets_ready` event; the local runner (from disk) or the sandbox's forward.py
-- (uploading straight to Vercel Blob) registers them here. Only the owner of the run can download them.

create table if not exists run_assets (
  run_id        text not null references runs (id) on delete cascade,
  -- the file's name as the engine reported it (also the last segment of the download URL)
  name          text not null,
  -- the engine's label: 'model', 'code', ...
  kind          text not null default 'file',
  content_type  text not null default 'application/octet-stream',
  bytes         bigint not null default 0,
  -- 'blob' (Vercel Blob, private store), 'local' (the API host's disk) or 'skipped' (not stored; see note)
  storage       text not null check (storage in ('blob', 'local', 'skipped')),
  blob_url      text,
  blob_pathname text,
  -- relative to the data dir (AUTOTINKER_DATA_DIR) for storage = 'local'
  local_path    text,
  -- why a file was skipped (too large, upload failed, storage not configured)
  note          text,
  created_at    timestamptz not null default now(),
  primary key (run_id, name)
);
