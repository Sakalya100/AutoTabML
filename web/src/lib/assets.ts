/**
 * Run assets: the charts and files the engine publishes after the report (the `assets_ready` event), and the
 * download listing the API serves for them (GET /api/runs/{id}/assets). Typed by hand: the generated schema
 * doesn't describe them yet. Everything here is tolerant: a malformed or unknown chart is dropped, never thrown.
 */

export type Point = [number, number];

interface ChartBase {
  id: string;
  title: string;
  note: string | null;
}

export interface CurveChart extends ChartBase {
  kind: "curve";
  xLabel: string;
  yLabel: string;
  series: { name: string; points: Point[] }[];
  diagonal: boolean;
}
export interface MatrixChart extends ChartBase {
  kind: "matrix";
  labels: string[];
  matrix: number[][];
}
export interface ScatterChart extends ChartBase {
  kind: "scatter";
  xLabel: string;
  yLabel: string;
  points: Point[];
  diagonal: boolean;
}
export interface HistogramChart extends ChartBase {
  kind: "histogram";
  xLabel: string;
  bins: { x0: number; x1: number; count: number }[];
}
export type AssetChart = CurveChart | MatrixChart | ScatterChart | HistogramChart;

export interface AssetFile {
  name: string;
  /** "model" | "code" | anything else the engine sends. */
  kind: string;
  bytes: number | null;
  contentType: string | null;
  /** From the API listing; null until the backend has the file. */
  downloadUrl: string | null;
  available: boolean;
  note: string | null;
}

/** One experiment's CV score, for the "CV score per experiment" chart every finished run has. */
export interface CvPoint {
  id: string;
  /** Oriented (higher is better); format with formatScore/toRaw. */
  mean: number;
  se: number;
  verdict: "keep" | "discard" | "crash" | null;
  best: boolean;
}

const MAX_POINTS = 1500;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, fallback = ""): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);

function point(v: unknown): Point | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = num(v[0]);
  const y = num(v[1]);
  return x == null || y == null ? null : [x, y];
}

function points(v: unknown): Point[] {
  if (!Array.isArray(v)) return [];
  const out: Point[] = [];
  for (const p of v) {
    const q = point(p);
    if (q) out.push(q);
  }
  return thin(out, MAX_POINTS);
}

/** Keep at most `max` points, evenly spaced (first and last kept), so a huge scatter can't stall the page. */
export function thin<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const step = (xs.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => xs[Math.round(i * step)]);
}

/** One chart from the event, or null if its kind is unknown or it has nothing to draw. */
export function parseChart(raw: unknown, index = 0): AssetChart | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const base: ChartBase = { id: text(o.id, `chart-${index}`), title: text(o.title, "Chart"), note: text(o.note) || null };
  switch (o.kind) {
    case "curve": {
      const series = (Array.isArray(o.series) ? o.series : [])
        .map((s, i) => {
          const so = (s ?? {}) as Record<string, unknown>;
          return { name: text(so.name, `Series ${i + 1}`), points: points(so.points) };
        })
        .filter((s) => s.points.length >= 2);
      if (!series.length) return null;
      return { ...base, kind: "curve", xLabel: text(o.x_label), yLabel: text(o.y_label), series, diagonal: o.diagonal === true };
    }
    case "matrix": {
      if (!Array.isArray(o.matrix) || !o.matrix.length) return null;
      const matrix = o.matrix.map((row) => (Array.isArray(row) ? row.map((c) => num(c) ?? 0) : []));
      const n = matrix.length;
      if (matrix.some((row) => row.length !== n)) return null;
      const labels = Array.isArray(o.labels) ? o.labels.map((l, i) => text(String(l ?? ""), String(i))) : [];
      return { ...base, kind: "matrix", labels: labels.length === n ? labels : matrix.map((_, i) => String(i)), matrix };
    }
    case "scatter": {
      const pts = points(o.points);
      if (!pts.length) return null;
      return { ...base, kind: "scatter", xLabel: text(o.x_label), yLabel: text(o.y_label), points: pts, diagonal: o.diagonal === true };
    }
    case "histogram": {
      const bins = (Array.isArray(o.bins) ? o.bins : [])
        .map((b) => {
          const bo = (b ?? {}) as Record<string, unknown>;
          const x0 = num(bo.x0);
          const x1 = num(bo.x1);
          const count = num(bo.count);
          return x0 == null || x1 == null || count == null || x1 <= x0 ? null : { x0, x1, count: Math.max(0, count) };
        })
        .filter((b): b is HistogramChart["bins"][number] => b != null);
      if (!bins.length) return null;
      return { ...base, kind: "histogram", xLabel: text(o.x_label), bins };
    }
    default:
      return null;
  }
}

/** Files named in the event: shown as "preparing…" until the API listing says they can be downloaded. */
export function parseEventFile(raw: unknown): AssetFile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = text(o.name) || text(o.path).split("/").pop() || "";
  if (!name) return null;
  return {
    name,
    kind: text(o.kind, "file"),
    bytes: num(o.bytes),
    contentType: text(o.content_type) || null,
    downloadUrl: null,
    available: false,
    note: null,
  };
}

/** The `assets_ready` event's payload; malformed parts are dropped. */
export function parseAssetsEvent(ev: unknown): { charts: AssetChart[]; files: AssetFile[] } {
  const o = (ev ?? {}) as Record<string, unknown>;
  const charts = (Array.isArray(o.charts) ? o.charts : []).map(parseChart).filter((c): c is AssetChart => c != null);
  const seen = new Set<string>();
  const files: AssetFile[] = [];
  for (const f of Array.isArray(o.files) ? o.files : []) {
    const p = parseEventFile(f);
    if (p && !seen.has(p.name)) {
      seen.add(p.name);
      files.push(p);
    }
  }
  return { charts, files };
}

/** GET /api/runs/{id}/assets → its files. Anything unexpected reads as "no listing yet" (an empty list). */
export function parseAssetsListing(body: unknown): AssetFile[] {
  const o = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.files)) return [];
  const out: AssetFile[] = [];
  for (const f of o.files) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const name = text(r.name);
    if (!name) continue;
    const url = text(r.downloadUrl) || text(r.download_url) || null;
    out.push({
      name,
      kind: text(r.kind, "file"),
      bytes: num(r.bytes),
      contentType: text(r.contentType) || text(r.content_type) || null,
      downloadUrl: url,
      available: r.available !== false && !!url,
      note: text(r.note) || null,
    });
  }
  return out;
}

/** Event files first (their order), then any extra the API lists; the API's fields win where both know a file. */
export function mergeFiles(fromEvent: readonly AssetFile[], listing: readonly AssetFile[]): AssetFile[] {
  const byName = new Map(listing.map((f) => [f.name, f]));
  const out = fromEvent.map((f) => {
    const l = byName.get(f.name);
    if (!l) return f;
    byName.delete(f.name);
    return { ...f, ...l, bytes: l.bytes ?? f.bytes, contentType: l.contentType ?? f.contentType };
  });
  return [...out, ...byName.values()];
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
