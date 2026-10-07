/**
 * Server-side preview of a public CSV link: rewrite share links, guard against SSRF, follow ≤ 3 redirects (each one
 * re-checked), read at most ~2 MB within 15 s, sniff that it's CSV/TSV, then parse the header + a sample.
 * The engine downloads the full file itself later, with the same guards (src/autotinker/data/fetch.py).
 */
import { looksLikeHtml, parseTable, type ColumnStats, type Delimiter } from "./csv";
import { rewriteShareLink } from "./share-links";
import { checkUrl, PreviewError, type Resolver } from "./ssrf";

export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** The engine refuses files above this (DEFAULT_MAX_BYTES in fetch.py). */
export const ENGINE_MAX_BYTES = 50 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "autotinker-preview/0.1 (+https://github.com/Sakalya100/AutoTabML)";

export interface PreviewDeps {
  fetch?: typeof fetch;
  resolver?: Resolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface FetchedHead {
  text: string;
  finalUrl: string;
  contentType: string | null;
  /** Bytes on the wire, if the server said (and the body isn't compressed). */
  contentLength: number | null;
  bytesRead: number;
  truncated: boolean;
}

export interface Preview {
  /** The link as pasted, and the direct link the engine will download. */
  url: string;
  resolvedUrl: string;
  finalUrl: string;
  rewritten: boolean;
  delimiter: Delimiter;
  columns: string[];
  stats: ColumnStats[];
  /** Up to 50 rows, for display in the browser only (never sent to Gemini). */
  sample: string[][];
  /** Exact if the whole file was read, else an estimate from the content length (null if unknown). */
  rows: number | null;
  rowsExact: boolean;
  sizeBytes: number | null;
}

export async function systemResolve(host: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const res = await lookup(host, { all: true, verbatim: true });
  return [...new Set(res.map((r) => r.address))];
}

/** GET with manual, re-checked redirects; reads at most `maxBytes` of the body. */
export async function fetchHead(url: string, deps: PreviewDeps = {}): Promise<FetchedHead> {
  const doFetch = deps.fetch ?? fetch;
  const resolve = deps.resolver ?? systemResolve;
  const maxBytes = deps.maxBytes ?? PREVIEW_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? 3;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let current = url;
  let redirects = 0;
  try {
    for (;;) {
      await checkUrl(current, resolve);
      let res: Response;
      try {
        res = await doFetch(current, {
          redirect: "manual",
          cache: "no-store",
          signal: ctrl.signal,
          headers: { "User-Agent": USER_AGENT, Accept: "text/csv, text/tab-separated-values, text/plain, */*;q=0.1" },
        });
      } catch (e) {
        if (ctrl.signal.aborted) throw new PreviewError("timeout", `The server took longer than ${Math.round(timeoutMs / 1000)} s to answer.`);
        throw new PreviewError("network", `Couldn't download the link (${(e as Error).message || "network error"}).`);
      }
      if (REDIRECTS.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        if (!location) throw new PreviewError("http_error", `The server sent a redirect (${res.status}) with no target.`);
        if (++redirects > maxRedirects) throw new PreviewError("too_many_redirects", `The link redirects more than ${maxRedirects} times.`);
        current = new URL(location, current).toString();
        continue;
      }
      if (res.status === 404 || res.status === 410)
        throw new PreviewError("not_found", "Nothing is at that link (404). Check that it's public and spelled right.");
      if (res.status === 401 || res.status === 403)
        throw new PreviewError("http_error", `The server refused access (${res.status}). The file must be public — anyone with the link can view.`);
      if (res.status >= 400) throw new PreviewError("http_error", `The server answered with an error (HTTP ${res.status}).`);

      const encoded = !!res.headers.get("content-encoding") && res.headers.get("content-encoding") !== "identity";
      const declared = Number(res.headers.get("content-length"));
      const contentLength = !encoded && Number.isFinite(declared) && declared > 0 ? declared : null;
      if (contentLength && contentLength > ENGINE_MAX_BYTES)
        throw new PreviewError("too_big", `The file is ${(contentLength / 1048576).toFixed(0)} MB; the limit is ${ENGINE_MAX_BYTES / 1048576} MB.`);

      const chunks: Uint8Array[] = [];
      let bytesRead = 0;
      let truncated = false;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          let r: ReadableStreamReadResult<Uint8Array>;
          try {
            r = await reader.read();
          } catch {
            if (ctrl.signal.aborted) throw new PreviewError("timeout", `The download took longer than ${Math.round(timeoutMs / 1000)} s.`);
            throw new PreviewError("network", "The download was interrupted.");
          }
          if (r.done) break;
          chunks.push(r.value);
          bytesRead += r.value.byteLength;
          if (bytesRead >= maxBytes) {
            truncated = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      }
      const buf = new Uint8Array(bytesRead);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.byteLength;
      }
      return {
        text: decode(buf.subarray(0, Math.min(bytesRead, maxBytes))),
        finalUrl: current,
        contentType: res.headers.get("content-type"),
        contentLength,
        bytesRead: Math.min(bytesRead, maxBytes),
        truncated,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

function decode(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Mostly replacement characters -> probably latin-1.
  const bad = (utf8.match(/�/g) ?? []).length;
  return bad > 20 && bad > utf8.length / 200 ? new TextDecoder("latin1").decode(bytes) : utf8;
}

/** Reject things that aren't delimited text. */
export function sniffContent(head: FetchedHead): void {
  const t = head.text;
  if (!t.trim()) throw new PreviewError("empty", "The link returned an empty file.");
  if (t.startsWith("PAR1")) throw new PreviewError("not_csv", "That's a Parquet file. The preview reads CSV/TSV only for now — link to a CSV export instead.");
  if (t.startsWith("PK\u0003\u0004")) throw new PreviewError("not_csv", "That's a ZIP archive. Link to the CSV file inside it instead.");
  if (t.charCodeAt(0) === 0x1f && t.charCodeAt(1) === 0x8b) throw new PreviewError("not_csv", "That's a gzip archive. Link to an uncompressed CSV instead.");
  if (looksLikeHtml(t, head.contentType))
    throw new PreviewError(
      "html",
      "That link opens a web page, not a data file. Use the direct download link (on GitHub, the “Raw” button; on Google Drive, make the file public).",
    );
  if (t.slice(0, 8192).includes("\u0000")) throw new PreviewError("not_csv", "That's a binary file, not a CSV or TSV.");
}

/** Fetch + parse. Throws PreviewError with a user-facing message. */
export async function buildPreview(url: string, deps: PreviewDeps = {}): Promise<Preview> {
  const pasted = url.trim();
  const resolvedUrl = rewriteShareLink(pasted);
  const head = await fetchHead(resolvedUrl, deps);
  sniffContent(head);
  const table = parseTable(head.text, { partial: head.truncated, sampleRows: 50 });
  if (table.columns.length < 2)
    throw new PreviewError("not_csv", "We couldn't find at least two columns. Is this a CSV or TSV with a header row?");
  const dup = table.columns.find((c, i) => table.columns.indexOf(c) !== i);
  if (dup) throw new PreviewError("not_csv", `Column "${dup}" appears twice in the header; every column needs a unique name.`);
  if (table.parsedRows < 1) throw new PreviewError("empty", "The file has a header but no data rows.");

  // Stats are computed on the first 5,000 rows; count the rest of what we read by line breaks.
  let lines = 0;
  for (let i = 0; i < head.text.length; i++) if (head.text.charCodeAt(i) === 10) lines++;
  if (!head.text.endsWith("\n")) lines++;
  const rowsRead = Math.max(table.parsedRows, lines - 1);
  let rows: number | null = rowsRead;
  let rowsExact = !head.truncated;
  if (head.truncated) {
    rowsExact = false;
    // Average bytes per row in what we read, extrapolated to the declared size.
    rows = head.contentLength ? Math.round((head.contentLength / head.bytesRead) * rowsRead) : null;
  }
  return {
    url: pasted,
    resolvedUrl,
    finalUrl: head.finalUrl,
    rewritten: resolvedUrl !== pasted,
    delimiter: table.delimiter,
    columns: table.columns,
    stats: table.stats,
    sample: table.sample,
    rows,
    rowsExact,
    sizeBytes: head.contentLength ?? (head.truncated ? null : head.bytesRead),
  };
}
