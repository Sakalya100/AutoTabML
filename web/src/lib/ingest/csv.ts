/**
 * CSV/TSV sniffing, parsing and column profiling for the link preview. Isomorphic (no Node imports).
 * Handles a UTF-8 BOM, CRLF, quoted fields (with "" escapes and embedded newlines) and `,` `;` `\t` `|` delimiters.
 */

export type Delimiter = "," | ";" | "\t" | "|";
export type ColumnKind = "numeric" | "integer" | "boolean" | "categorical" | "text" | "datetime" | "id" | "empty";

export interface ColumnStats {
  name: string;
  kind: ColumnKind;
  /** Non-missing values seen in the parsed rows. */
  count: number;
  missing: number;
  unique: number;
  /** Numeric columns only. */
  min?: number;
  max?: number;
  /** Rows in the rarest value, when there are 2–50 distinct values (class balance for a classification target). */
  minCount?: number;
}

const MISSING = new Set(["", "na", "n/a", "nan", "null", "none", "?", "-", "--", "#n/a"]);
export const isMissing = (v: string | undefined) => v == null || MISSING.has(v.trim().toLowerCase());

export const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Count delimiter occurrences outside quotes in one line. */
function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (!q && ch === d) n++;
  }
  return n;
}

/** Pick the delimiter that appears the same (non-zero) number of times on the most of the first lines. */
export function sniffDelimiter(text: string): Delimiter {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, 12);
  let best: Delimiter = ",";
  let bestScore = -1;
  for (const d of [",", "\t", ";", "|"] as Delimiter[]) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const head = counts[0] ?? 0;
    if (head === 0) continue;
    const consistent = counts.filter((c) => c === head).length;
    const score = consistent * 1000 + head;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Parse delimited text into records. `partial` = the text is a prefix of the file, so the last record may be cut
 * mid-way and is dropped. Stops after `maxRecords` records (header included).
 */
export function parseDelimited(text: string, delimiter: Delimiter, opts: { maxRecords?: number; partial?: boolean } = {}): string[][] {
  const src = stripBom(text);
  const max = opts.maxRecords ?? Infinity;
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let complete = true; // false while inside a record that hasn't ended with a newline
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    complete = false;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = "";
      fieldStarted = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field.trim());
      if (!(row.length === 1 && row[0] === "")) out.push(row);
      row = [];
      field = "";
      fieldStarted = false;
      complete = true;
      if (out.length >= max) return out;
    } else {
      field += ch;
      if (ch !== " " && ch !== "\t") fieldStarted = true;
    }
  }
  if (!complete && !opts.partial && !inQuotes) {
    row.push(field.trim());
    if (!(row.length === 1 && row[0] === "")) out.push(row);
  }
  return out.slice(0, max);
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOOL = new Set(["true", "false", "yes", "no", "t", "f", "y", "n"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const ID_NAME = /^(id|index|uuid|guid|key|row ?id|unnamed: ?0|passengerid|customerid|customer ?id)$|(^|[_\s.-])id$|^id[_\s.-]/i;

/** Infer one column's kind from its values (strings as parsed). */
export function profileColumn(name: string, values: string[]): ColumnStats {
  const present = values.filter((v) => !isMissing(v));
  const missing = values.length - present.length;
  const uniq = new Set(present);
  const base: { name: string; count: number; missing: number; unique: number; minCount?: number } = { name, count: present.length, missing, unique: uniq.size };
  if (uniq.size >= 2 && uniq.size <= 50) {
    const freq = new Map<string, number>();
    for (const v of present) freq.set(v, (freq.get(v) ?? 0) + 1);
    base.minCount = Math.min(...freq.values());
  }
  if (!present.length) return { ...base, kind: "empty" };

  const allNum = present.every((v) => NUM_RE.test(v.replace(/,/g, "")));
  if (allNum) {
    const nums = present.map((v) => Number(v.replace(/,/g, "")));
    const ints = nums.every((n) => Number.isInteger(n));
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (ints && uniq.size === 2 && min === 0 && max === 1) return { ...base, kind: "boolean", min, max };
    const idLike = ints && ID_NAME.test(name) && uniq.size === present.length && present.length >= 10;
    return { ...base, kind: idLike ? "id" : ints ? "integer" : "numeric", min, max };
  }
  const lower = new Set(present.map((v) => v.toLowerCase()));
  if (lower.size <= 2 && [...lower].every((v) => BOOL.has(v))) return { ...base, kind: "boolean" };
  if (present.filter((v) => DATE_RE.test(v)).length >= present.length * 0.9) return { ...base, kind: "datetime" };
  if (ID_NAME.test(name) && uniq.size >= present.length * 0.95) return { ...base, kind: "id" };
  const avgLen = present.reduce((a, v) => a + v.length, 0) / present.length;
  // Few distinct values, or short repeated strings -> categorical; long, mostly unique strings -> free text.
  const categorical = uniq.size <= Math.max(20, present.length * 0.5) && avgLen < 40;
  return { ...base, kind: categorical ? "categorical" : "text" };
}

export interface ParsedTable {
  delimiter: Delimiter;
  columns: string[];
  /** Up to `sampleRows` data rows, for display. */
  sample: string[][];
  /** Data rows parsed (all of them, up to the stats cap). */
  parsedRows: number;
  stats: ColumnStats[];
}

/** Header + profile of the start of a delimited file. */
export function parseTable(text: string, opts: { partial?: boolean; sampleRows?: number; statsRows?: number } = {}): ParsedTable {
  const delimiter = sniffDelimiter(text);
  const statsRows = opts.statsRows ?? 5000;
  const records = parseDelimited(text, delimiter, { partial: opts.partial, maxRecords: statsRows + 1 });
  const header = records.shift() ?? [];
  const columns = header.map((c, i) => c || `column_${i + 1}`);
  const width = columns.length;
  const rows = records.map((r) => (r.length >= width ? r.slice(0, width) : [...r, ...Array(width - r.length).fill("")]));
  const stats = columns.map((c, j) =>
    profileColumn(
      c,
      rows.map((r) => r[j]),
    ),
  );
  return { delimiter, columns, sample: rows.slice(0, opts.sampleRows ?? 50), parsedRows: rows.length, stats };
}

/** True if the bytes look like a web page rather than a data file (Drive's virus-scan page, a GitHub HTML view). */
export function looksLikeHtml(head: string, contentType: string | null): boolean {
  const t = stripBom(head).trimStart().slice(0, 2048).toLowerCase();
  if (t.startsWith("<!doctype html") || t.startsWith("<html")) return true;
  return (contentType ?? "").toLowerCase().includes("text/html") && /<(html|!doctype|head|body)\b/.test(t);
}
