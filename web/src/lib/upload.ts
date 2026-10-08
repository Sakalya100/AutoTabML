/**
 * Run-request validation for the new-run form (the backend repeats these checks in backend/autotinker_api/validation.py).
 * Two sources: a public https link (the engine downloads it) or an uploaded CSV file.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_EXPERIMENTS_PUBLIC = 10;
export const DEFAULT_EXPERIMENTS = 10;
export const MIN_DATA_ROWS = 20;
export const MAX_DESCRIPTION = 2000;
export const MAX_URL_LENGTH = 2048;
/** Metric ids the engine accepts (autotinker.contracts.Metric). */
export const ENGINE_METRICS = ["roc_auc", "log_loss", "accuracy", "f1_macro", "rmse", "mae", "r2"] as const;
export type EngineMetric = (typeof ENGINE_METRICS)[number];

/** Split one CSV record (RFC 4180 quoting, "" escapes). Does not handle newlines inside quotes. */
export function splitCsvLine(line: string, delimiter = ","): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"' && cur.trim() === "") {
      inQuotes = true;
      cur = "";
    } else if (ch === delimiter) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export interface CsvPreview {
  columns: string[];
  rows: string[][];
  /** Data rows counted in the text that was given (a lower bound if the text is a prefix). */
  rowCount: number;
}

/** Parse the header and the first few rows from the start of a CSV file. Strips a UTF-8 BOM. */
export function previewCsv(text: string, maxRows = 5): CsvPreview {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/);
  const header = lines.shift() ?? "";
  const columns = header.trim() ? splitCsvLine(header) : [];
  const dataLines = lines.filter((l) => l.trim() !== "");
  return { columns, rows: dataLines.slice(0, maxRows).map((l) => splitCsvLine(l)), rowCount: dataLines.length };
}

/** The run options common to both sources. */
export interface RunOptionsInput {
  target: string;
  /** The user's sentence ("predict churn"). Passed to the engine as --goal. */
  goal?: string;
  metric?: string | null;
  maxExperiments: number | string;
}

export interface ValidRunOptions {
  target: string;
  goal: string;
  metric: EngineMetric | null;
  maxExperiments: number;
}

export type Invalid = { ok: false; field: string; error: string };
export type Valid<T> = { ok: true; value: T };
const bad = (field: string, error: string): Invalid => ({ ok: false, field, error });

export function validateRunOptions(input: RunOptionsInput, columns: string[] | null, opts: { maxExperiments?: number } = {}): Valid<ValidRunOptions> | Invalid {
  const maxExp = opts.maxExperiments ?? MAX_EXPERIMENTS_PUBLIC;
  const target = (input.target ?? "").trim();
  if (!target) return bad("target", "Pick the column to predict.");
  if (target.length > 200 || /[\r\n\u0000]/.test(target)) return bad("target", "That column name is not valid.");
  if (columns && !columns.includes(target)) return bad("target", `Column "${target}" is not in the CSV header.`);

  const n = typeof input.maxExperiments === "number" ? input.maxExperiments : Number(input.maxExperiments);
  if (!Number.isInteger(n) || n < 1 || n > maxExp) return bad("maxExperiments", `Experiments must be a whole number from 1 to ${maxExp}.`);

  const goal = (input.goal ?? "").trim();
  if (goal.length > MAX_DESCRIPTION) return bad("goal", `Keep the sentence under ${MAX_DESCRIPTION} characters.`);

  const m = (input.metric ?? "").trim();
  if (m && !(ENGINE_METRICS as readonly string[]).includes(m)) return bad("metric", "Choose one of the listed metrics.");

  return { ok: true, value: { target, goal, metric: (m || null) as EngineMetric | null, maxExperiments: n } };
}

/** A public link: https only here; the SSRF checks happen server-side (preview) and again in the engine. */
export function validateUrlRunRequest(input: RunOptionsInput & { url: string }, opts: { maxExperiments?: number } = {}): Valid<ValidRunOptions & { url: string }> | Invalid {
  const raw = (input.url ?? "").trim();
  if (!raw) return bad("url", "Paste a link to a CSV file.");
  if (raw.length > MAX_URL_LENGTH) return bad("url", "That link is too long.");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return bad("url", "That isn't a valid link. Paste the full address, starting with https://");
  }
  if (u.protocol !== "https:") return bad("url", "Only https:// links are supported.");
  if (u.username || u.password) return bad("url", "Links with a user name or password in them aren't allowed.");
  const v = validateRunOptions(input, null, opts);
  if (!v.ok) return v;
  return { ok: true, value: { ...v.value, url: u.toString() } };
}

export interface RunRequestInput extends RunOptionsInput {
  fileName: string;
  fileBytes: number;
  /** The beginning (or all) of the file as text. */
  head: string;
  /** True if `head` is the whole file. */
  complete: boolean;
}

export interface ValidRunRequest extends ValidRunOptions {
  columns: string[];
}

export type ValidationResult = Valid<ValidRunRequest> | Invalid;

/** An uploaded CSV file. */
export function validateRunRequest(input: RunRequestInput, opts: { maxExperiments?: number } = {}): ValidationResult {
  if (!input.fileName || !/\.csv$/i.test(input.fileName)) return bad("file", "Upload a .csv file.");
  if (input.fileBytes <= 0) return bad("file", "The file is empty.");
  if (input.fileBytes > MAX_UPLOAD_BYTES) return bad("file", `The file is ${(input.fileBytes / 1048576).toFixed(1)} MB; the limit for uploads is 5 MB. Paste a link instead (up to 50 MB).`);
  if (input.head.slice(0, 4096).includes("\u0000")) return bad("file", "This doesn't look like a text CSV file.");

  const { columns, rowCount } = previewCsv(input.head, 0);
  if (columns.length < 2) return bad("file", "The CSV needs a header row with at least two columns.");
  if (columns.some((c) => c === "")) return bad("file", "Every column in the header needs a name.");
  const dup = columns.find((c, i) => columns.indexOf(c) !== i);
  if (dup) return bad("file", `Column "${dup}" appears twice in the header.`);
  if (input.complete && rowCount < MIN_DATA_ROWS) return bad("file", `Need at least ${MIN_DATA_ROWS} data rows; found ${rowCount}.`);

  const v = validateRunOptions(input, columns, opts);
  if (!v.ok) return v;
  return { ok: true, value: { ...v.value, columns } };
}
