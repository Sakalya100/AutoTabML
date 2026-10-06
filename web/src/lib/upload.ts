/**
 * Upload validation shared by the /new form (client) and POST /api/runs (server). No Node-only imports.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_EXPERIMENTS_PUBLIC = 30;
export const MIN_DATA_ROWS = 20;
export const MAX_DESCRIPTION = 2000;
export const LLM_CHOICES = ["heuristic", "anthropic"] as const;
export type LlmChoice = (typeof LLM_CHOICES)[number];

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

export interface RunRequestInput {
  fileName: string;
  fileBytes: number;
  /** The beginning (or all) of the file as text. */
  head: string;
  /** True if `head` is the whole file. */
  complete: boolean;
  target: string;
  description: string;
  maxExperiments: number | string;
  llm: string;
  apiKey?: string | null;
}

export interface ValidRunRequest {
  target: string;
  description: string;
  maxExperiments: number;
  llm: LlmChoice;
  columns: string[];
}

export type ValidationResult = { ok: true; value: ValidRunRequest } | { ok: false; field: string; error: string };

const bad = (field: string, error: string): ValidationResult => ({ ok: false, field, error });

export function validateRunRequest(input: RunRequestInput, opts: { maxExperiments?: number } = {}): ValidationResult {
  const maxExp = opts.maxExperiments ?? MAX_EXPERIMENTS_PUBLIC;
  if (!input.fileName || !/\.csv$/i.test(input.fileName)) return bad("file", "Upload a .csv file.");
  if (input.fileBytes <= 0) return bad("file", "The file is empty.");
  if (input.fileBytes > MAX_UPLOAD_BYTES) return bad("file", `The file is ${(input.fileBytes / 1048576).toFixed(1)} MB; the limit is 5 MB.`);
  if (input.head.slice(0, 4096).includes("\u0000")) return bad("file", "This doesn't look like a text CSV file.");

  const { columns, rowCount } = previewCsv(input.head, 0);
  if (columns.length < 2) return bad("file", "The CSV needs a header row with at least two columns.");
  if (columns.some((c) => c === "")) return bad("file", "Every column in the header needs a name.");
  const dup = columns.find((c, i) => columns.indexOf(c) !== i);
  if (dup) return bad("file", `Column "${dup}" appears twice in the header.`);
  if (input.complete && rowCount < MIN_DATA_ROWS) return bad("file", `Need at least ${MIN_DATA_ROWS} data rows; found ${rowCount}.`);

  const target = (input.target ?? "").trim();
  if (!target) return bad("target", "Pick the column to predict.");
  if (!columns.includes(target)) return bad("target", `Column "${target}" is not in the CSV header.`);

  const n = typeof input.maxExperiments === "number" ? input.maxExperiments : Number(input.maxExperiments);
  if (!Number.isInteger(n) || n < 1 || n > maxExp) return bad("maxExperiments", `Max experiments must be a whole number from 1 to ${maxExp}.`);

  const description = (input.description ?? "").trim();
  if (description.length > MAX_DESCRIPTION) return bad("description", `Keep the description under ${MAX_DESCRIPTION} characters.`);

  if (!(LLM_CHOICES as readonly string[]).includes(input.llm)) return bad("llm", "Choose the offline heuristic or Anthropic.");
  if (input.apiKey != null && input.apiKey !== "") {
    if (input.llm !== "anthropic") return bad("apiKey", "An API key is only used with the Anthropic proposer.");
    if (input.apiKey.length > 300 || /\s/.test(input.apiKey)) return bad("apiKey", "That doesn't look like an API key.");
  }

  return { ok: true, value: { target, description, maxExperiments: n, llm: input.llm as LlmChoice, columns } };
}

/** Replace any occurrence of the given secrets (and anything shaped like an Anthropic key) in log text. */
export function redact(text: string, secrets: (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}
