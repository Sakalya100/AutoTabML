/**
 * The closing card of a run that didn't finish: a plain message, a hint, and which actions make sense.
 *
 * The engine ends a failed run with a `run_failed` event ({code, message, hint}; src/autotinker/failures.py); the
 * backend stores it on the run (or guesses a code from the exit when the engine died without one; backend
 * autotinker_api/failures.py) and sends it as the run meta's `error` / `errorCode` / `hint`.
 */

export type FailureCode =
  | "download_failed"
  | "not_csv"
  | "file_not_found"
  | "target_missing"
  | "target_empty"
  | "too_few_rows"
  | "llm_unavailable"
  | "out_of_memory"
  | "out_of_time"
  | "unexpected";

export interface RunEndInput {
  status: "failed" | "cancelled" | "timed_out";
  error: string | null;
  errorCode?: string | null;
  hint?: string | null;
  /** "url" runs can be started again from their link; an uploaded file is not kept after the run. */
  source?: "url" | "file" | null;
}

export interface RunEndView {
  label: string;
  /** Short headline in the card's title slot. */
  title: string | null;
  text: string;
  hint: string | null;
  /** Show Retry (same settings, same session). */
  retry: boolean;
  /** Show Edit setup (re-open the setup pane with the run's link). */
  edit: boolean;
  /** Which button is the main one: a wrong column needs the setup, a flaky download just a retry. */
  primary: "retry" | "edit";
  /** Why Retry isn't offered, when it isn't. */
  note: string | null;
}

const TITLES: Record<FailureCode, string> = {
  download_failed: "The file couldn’t be downloaded",
  not_csv: "That isn’t a table we can read",
  file_not_found: "The data file is gone",
  target_missing: "That column isn’t in the file",
  target_empty: "Nothing to predict in that column",
  too_few_rows: "Too few rows to learn from",
  llm_unavailable: "The AI models are unavailable",
  out_of_memory: "It ran out of memory",
  out_of_time: "It ran out of time",
  unexpected: "Something went wrong",
};

/** Codes where running the same settings again can't help: the setup has to change. */
const NEEDS_SETUP = new Set<FailureCode>(["target_missing", "target_empty", "too_few_rows", "not_csv"]);

const isCode = (c: string | null | undefined): c is FailureCode => !!c && c in TITLES;

export function runEndView(it: RunEndInput): RunEndView {
  const fromLink = it.source !== "file";
  const note = fromLink ? null : "Uploaded files aren’t kept after a run; attach the file again to retry.";
  if (it.status === "cancelled")
    return {
      label: "Cancelled",
      title: null,
      text: it.error && it.error !== "Cancelled by user." ? it.error : "The run was cancelled before the locked test.",
      hint: null,
      retry: fromLink,
      edit: fromLink,
      primary: "retry",
      note,
    };
  if (it.status === "timed_out")
    return {
      label: "Timed out",
      title: null,
      text: it.error ?? "The run timed out before the locked test; every experiment so far is kept.",
      hint: it.hint ?? "Retry, perhaps with fewer experiments.",
      retry: fromLink,
      edit: fromLink,
      primary: "retry",
      note,
    };
  const code: FailureCode = isCode(it.errorCode) ? it.errorCode : "unexpected";
  const legacy = !it.errorCode && /^The engine exited with code|^The engine was killed/.test(it.error ?? "");
  return {
    label: "The run failed",
    title: TITLES[code],
    text: legacy || !it.error ? "The engine stopped with an error before it could finish." : it.error,
    hint: it.hint ?? (legacy ? "Retry; if it fails again, open the setup and check the column to predict." : null),
    retry: fromLink,
    edit: fromLink,
    primary: NEEDS_SETUP.has(code) ? "edit" : "retry",
    note,
  };
}
