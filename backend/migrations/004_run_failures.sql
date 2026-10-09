-- Failures users understand, and one CSV format for the preview and the engine.
--   error_code / error_hint: why a failed run failed (autotinker_api/failures.py; the engine's run_failed codes),
--     shown with `error` on the failed-run card.
--   csv_format: {delimiter, encoding, decimal} as the link preview (or the upload check) detected them, passed to
--     the engine as --delimiter / --encoding / --decimal so it parses the file exactly as the preview did.

alter table runs
  add column if not exists error_code text,
  add column if not exists error_hint text,
  add column if not exists csv_format jsonb;
