"use client";

/**
 * The run's assets, after the report: one tile per chart (with a thumbnail) and one per file (name, size, Download).
 * A tile opens a preview over the workspace: the chart in full, a file's text, or for the model the "Use this model"
 * panel (download everything as a zip, install, predict from the command line or Python, the columns it expects —
 * all read from the engine's model_card.json).
 * Downloads come from GET /api/runs/{id}/assets (one file) and /api/runs/{id}/assets.zip (all of them); previews read
 * small text files same-origin with `?inline=1`. Until a file is listed as available it reads "preparing…".
 */
import { useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fmtBytes, mergeFiles, parseAssetsListing, type AssetChart, type AssetFile } from "@/lib/assets";
import { fmtNum, metricInfo } from "@/lib/metrics";
import type { ChatAssets } from "@/lib/chat";
import type { Metric } from "@/lib/schema";
import { CodeView } from "../code-view";
import { ChartThumb, ChartView } from "./asset-charts";
import { spotlight } from "./fx/motion";
import { gsap } from "@/lib/motion/gsap";

type Preview = { kind: "chart"; chart: AssetChart } | { kind: "cv" } | { kind: "file"; name: string };

const POLL_MS = 4000;
const POLL_MAX = 15;

/** The API's download listing, merged with the files the event named. Re-polls (bounded) while any is preparing. */
function useAssetFiles(runId: string, fromEvent: AssetFile[], ready: boolean): AssetFile[] {
  const [listing, setListing] = useState<AssetFile[]>([]);
  const names = fromEvent.map((f) => f.name).join("|");
  useEffect(() => {
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      tries++;
      let files: AssetFile[] = [];
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/assets`, { cache: "no-store" });
        if (res.ok) files = parseAssetsListing(await res.json());
      } catch {
        files = [];
      }
      if (!alive) return;
      setListing(files);
      const waiting = names ? names.split("|").some((n) => !files.find((f) => f.name === n && f.available)) : false;
      if (waiting && tries < POLL_MAX) timer = setTimeout(load, POLL_MS);
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, names, ready]);
  return mergeFiles(fromEvent, listing);
}

export function AssetsCard({ it, metric, enter = false }: { it: ChatAssets; metric: Metric | null; enter?: boolean }) {
  const files = useAssetFiles(it.runId, it.files, it.ready);
  const [preview, setPreviewState] = useState<Preview | null>(null);
  /** The tile a preview was opened from: the sheet grows out of it and settles back into it. */
  const origin = useRef<DOMRect | null>(null);
  const setPreview = (p: Preview | null, e?: MouseEvent<HTMLElement>) => {
    if (e) origin.current = (e.currentTarget.closest(".as-tile") ?? e.currentTarget).getBoundingClientRect();
    setPreviewState(p);
  };
  const pipeline = files.find((f) => f.kind === "code") ?? null;
  const card = files.find((f) => f.name === CARD_FILE) ?? null;
  const zipUrl = files.some((f) => f.available) ? `/api/runs/${encodeURIComponent(it.runId)}/assets.zip` : null;
  // Looked up by name on every render, so a preview opened while "preparing…" turns into a download when ready.
  const previewFile = preview?.kind === "file" ? (files.find((f) => f.name === preview.name) ?? null) : null;
  const isModel = previewFile?.kind === "model";
  const count = it.charts.length + (it.cv.length ? 1 : 0) + files.length;
  if (!count) return null;
  return (
    <section className="ws-card as-card" aria-label="Assets">
      <header className="ws-card-head">
        <p className="ws-label">Assets</p>
        <p className="ws-label-muted">
          {count} item{count === 1 ? "" : "s"}
          {!it.ready && " · charts and files appear when the engine publishes them"}
        </p>
        {zipUrl && files.some((f) => f.kind === "model") && <ZipLink url={zipUrl} runId={it.runId} />}
      </header>
      <ul className="as-grid" data-enter={enter || undefined} onPointerMove={spotlight}>
        {it.cv.length > 0 && (
          <li style={at(0)}>
            <ChartTile
              title="CV score per experiment"
              sub={`${it.cv.length} experiment${it.cv.length === 1 ? "" : "s"}`}
              onOpen={(e) => setPreview({ kind: "cv" }, e)}
            >
              <ChartThumb chart="cv" cv={it.cv} />
            </ChartTile>
          </li>
        )}
        {it.charts.map((c, i) => (
          <li key={c.id} style={at(i + 1)}>
            <ChartTile title={c.title} sub={chartSub(c)} onOpen={(e) => setPreview({ kind: "chart", chart: c }, e)}>
              <ChartThumb chart={c} />
            </ChartTile>
          </li>
        ))}
        {files.map((f, i) => (
          <li key={f.name} style={at(it.charts.length + 1 + i)}>
            <FileTile file={f} onOpen={(e) => setPreview({ kind: "file", name: f.name }, e)} />
          </li>
        ))}
      </ul>
      <PreviewDialog
        open={!!preview}
        origin={origin}
        onClose={() => setPreview(null)}
        title={
          !preview
            ? ""
            : preview.kind === "cv"
              ? "CV score per experiment"
              : preview.kind === "chart"
                ? preview.chart.title
                : isModel
                  ? "Use this model"
                  : preview.name
        }
        sub={
          !preview
            ? null
            : preview.kind === "cv"
              ? "Every scored experiment, with ± 1 standard error. Filled: kept by the gate."
              : preview.kind === "chart"
                ? preview.chart.note
                : previewFile && fileBlurb(previewFile)
        }
        action={
          previewFile ? (
            isModel && zipUrl ? (
              <>
                <span className="hidden sm:contents">
                  <DownloadLink file={previewFile} />
                </span>
                <ZipLink url={zipUrl} runId={it.runId} primary />
              </>
            ) : (
              <DownloadLink file={previewFile} primary />
            )
          ) : null
        }
      >
        {preview?.kind === "cv" && <ChartView chart="cv" cv={it.cv} metric={metric} />}
        {preview?.kind === "chart" && <ChartView chart={preview.chart} />}
        {previewFile && (isModel ? <UseModel model={previewFile} card={card} pipeline={pipeline} files={files} /> : <FilePreview file={previewFile} />)}
      </PreviewDialog>
    </section>
  );
}

const at = (i: number) => ({ "--i": i }) as CSSProperties;

function chartSub(c: AssetChart): string {
  switch (c.kind) {
    case "curve":
      return c.series.map((s) => s.name).join(" · ");
    case "matrix":
      return `${c.labels.length} × ${c.labels.length}`;
    case "scatter":
      return `${c.points.length.toLocaleString("en-US")} points`;
    case "histogram":
      return `${c.bins.reduce((a, b) => a + b.count, 0).toLocaleString("en-US")} rows`;
  }
}

const CARD_FILE = "model_card.json";

function fileBlurb(f: AssetFile): string {
  if (f.kind === "model") return "The best model, refitted on all the training data and scored once on the held-out test rows.";
  if (f.kind === "code") return "The training pipeline the best model came from: build_pipeline(profile) returns the unfitted scikit-learn pipeline.";
  if (f.kind === "script") return "Run it next to model.joblib: python predict.py new_rows.csv -o predictions.csv. Or import load and predict from it.";
  if (f.kind === "text") return "The exact package versions the model was trained with. Install them before loading it.";
  if (f.kind === "json") return "What the model expects and what it was scored on: target, classes, input columns with types, versions.";
  return f.note ?? "";
}

const KIND_LABEL: Record<string, string> = { model: "model", code: "code", script: "script", text: "text", json: "json" };

function ZipLink({ url, runId, primary }: { url: string; runId: string; primary?: boolean }) {
  return (
    <a
      href={url}
      download={`autotinker-${runId}.zip`}
      className={primary ? "as-dl as-dl-primary" : "as-dl ml-auto"}
      title="model.joblib, predict.py, requirements.txt, model_card.json and pipeline.py in one zip"
    >
      <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
        <path d="M6 1.5v6.5M3 5.5 6 8.5 9 5.5M2 10.5h8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Download all<span className="hidden sm:inline">&nbsp;(zip)</span>
    </a>
  );
}

function ChartTile({ title, sub, onOpen, children }: { title: string; sub: string; onOpen: (e: MouseEvent<HTMLElement>) => void; children: ReactNode }) {
  return (
    <button type="button" className="as-tile" data-spot onClick={onOpen} aria-haspopup="dialog">
      <span className="as-tile-art">{children}</span>
      <span className="as-tile-title">{title}</span>
      <span className="as-tile-sub" title={sub}>
        {sub}
      </span>
    </button>
  );
}

function FileTile({ file, onOpen }: { file: AssetFile; onOpen: (e: MouseEvent<HTMLElement>) => void }) {
  return (
    <div className="as-tile as-file" data-spot>
      <button type="button" className="as-tile-hit" onClick={onOpen} aria-haspopup="dialog" aria-label={`Preview ${file.name}`} />
      <span className="as-tile-art as-file-art">
        <FileIcon kind={file.kind} />
      </span>
      <span className="as-tile-title" title={file.name}>
        {file.name}
      </span>
      <span className="as-tile-sub">{[KIND_LABEL[file.kind] ?? null, fmtBytes(file.bytes)].filter(Boolean).join(" · ")}</span>
      <span className="as-tile-dl">
        <DownloadLink file={file} />
      </span>
    </div>
  );
}

function DownloadLink({ file, primary }: { file: AssetFile; primary?: boolean }) {
  if (!file.available || !file.downloadUrl)
    return (
      <span className={primary ? "as-dl as-dl-primary as-dl-off" : "as-dl as-dl-off"} title={file.note ?? "The backend is still preparing this file"}>
        preparing…
      </span>
    );
  return (
    <a href={file.downloadUrl} download={file.name} className={primary ? "as-dl as-dl-primary" : "as-dl"}>
      <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
        <path d="M6 1.5v6.5M3 5.5 6 8.5 9 5.5M2 10.5h8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Download
    </a>
  );
}

function FileIcon({ kind }: { kind: string }) {
  if (kind === "model")
    return (
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <path d="M16 4 27 10v12L16 28 5 22V10Z" fill="none" stroke="var(--lp-signal)" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5 10l11 6 11-6M16 16v12" fill="none" stroke="var(--lp-signal)" strokeWidth="1.3" strokeLinejoin="round" strokeOpacity="0.6" />
      </svg>
    );
  return (
    <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
      <path d="M8 4h11l6 6v18H8Z" fill="none" stroke="var(--lp-ink-2)" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M19 4v6h6" fill="none" stroke="var(--lp-ink-2)" strokeWidth="1.3" strokeLinejoin="round" />
      {(kind === "code" || kind === "script") && (
        <path d="m14 15-3 3 3 3M19 15l3 3-3 3" fill="none" stroke="var(--lp-signal)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/** model_card.json, as far as the panel needs it. Anything missing or malformed reads as absent. */
interface CardFeature {
  name: string;
  dtype: string;
  required: boolean;
}
interface ModelCard {
  target: string;
  problemType: string;
  metric: string;
  testScore: number | null;
  classes: string[] | null;
  features: CardFeature[];
  exampleRow: Record<string, unknown>;
  dropped: string[];
  versions: Record<string, string>;
}

function parseCard(text: string): ModelCard | null {
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const features = (Array.isArray(o.features) ? o.features : [])
    .map((f) => (f && typeof f === "object" ? (f as Record<string, unknown>) : null))
    .filter((f): f is Record<string, unknown> => !!f && typeof f.name === "string")
    .map((f) => ({ name: str(f.name), dtype: str(f.dtype), required: f.required !== false }));
  const versions: Record<string, string> = {};
  if (o.versions && typeof o.versions === "object") for (const [k, v] of Object.entries(o.versions)) if (typeof v === "string") versions[k] = v;
  return {
    target: str(o.target),
    problemType: str(o.problem_type),
    metric: str(o.metric),
    testScore: typeof o.test_score === "number" && Number.isFinite(o.test_score) ? o.test_score : null,
    classes: Array.isArray(o.classes) ? o.classes.map((c) => String(c)) : null,
    features,
    exampleRow: o.example_row && typeof o.example_row === "object" && !Array.isArray(o.example_row) ? (o.example_row as Record<string, unknown>) : {},
    dropped: Array.isArray(o.dropped_columns) ? o.dropped_columns.map((c) => String(c)) : [],
    versions,
  };
}

/** A pandas dtype in words. */
function typeLabel(dtype: string): string {
  const d = dtype.toLowerCase();
  if (d.startsWith("int") || d.startsWith("uint")) return "integer";
  if (d.startsWith("float")) return "number";
  if (d.startsWith("bool")) return "true / false";
  if (d.startsWith("datetime")) return "date";
  if (d === "category") return "category";
  return "text";
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const PY_USAGE = (target: string) => `import pandas as pd
from predict import load, predict  # predict.py, next to model.joblib

model = load()                      # loads model.joblib from that folder
rows = pd.read_csv("new_rows.csv")  # the columns below${target ? `, no "${target}"` : ""}
out = predict(model, rows)          # a DataFrame like the CLI writes

labels = model.predict(rows)        # original labels, scikit-learn style
raw = model.model                   # the fitted scikit-learn estimator itself`;

/** The model's preview: everything a stranger needs to run it, from model_card.json. */
function UseModel({ model, card, pipeline, files }: { model: AssetFile; card: AssetFile | null; pipeline: AssetFile | null; files: AssetFile[] }) {
  const cardText = useFileText(card);
  const info = cardText.state === "ok" ? parseCard(cardText.text) : null;
  const has = (n: string) => files.some((f) => f.name === n);
  const sk = info?.versions["scikit-learn"];
  const py = info?.versions.python;
  const classes = info?.classes ?? null;
  const shownClasses = classes && classes.length > 6 ? [...classes.slice(0, 6), "…"] : classes;
  const outCols = classes ? ["prediction", ...(shownClasses ?? []).map((c) => (c === "…" ? "…" : `proba_${c}`))] : ["prediction"];
  const example =
    info && info.features.length
      ? info.features
          .map((f) => f.name)
          .map(csvCell)
          .join(",") +
        "\n" +
        info.features.map((f) => csvCell(info.exampleRow[f.name])).join(",")
      : null;
  const legacy = !has("predict.py");
  return (
    <div className="space-y-6">
      {info && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13.5px] sm:grid-cols-4">
          <Fact label="Predicts" value={info.target || "—"} />
          <Fact label="Task" value={info.problemType ? info.problemType.replace(/^\w/, (c) => c.toUpperCase()) : "—"} />
          <Fact label={`Test ${metricInfo(info.metric).label}`} value={info.testScore == null ? "—" : fmtNum(info.testScore, metricInfo(info.metric).digits)} />
          <Fact label="Answers in" value={classes ? (classes.length <= 3 ? classes.join(" / ") : `${classes.length} classes`) : "numbers"} />
        </dl>
      )}

      {legacy ? (
        <Step n={1} title="Load it with joblib">
          <CodeView
            code={`import joblib\nimport pandas as pd\n\nmodel = joblib.load("${model.name}")\npredictions = model.predict(pd.read_csv("new_rows.csv"))  # same columns as the training data`}
          />
          <p className="mt-2 text-[13px] text-[var(--lp-ink-3)]">
            This run predates predict.py: classifiers return encoded labels 0…k−1 (in sorted class order).
          </p>
        </Step>
      ) : (
        <ol className="space-y-5">
          <Step n={1} title="Install the exact versions it was trained with">
            <Snippet code="pip install -r requirements.txt" />
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--lp-ink-3)]">
              {sk ? (
                <>
                  Pinned to <span className="font-mono text-[var(--lp-ink-2)]">scikit-learn {sk}</span>
                  {py && <> on Python {py.split(".").slice(0, 2).join(".")}</>}. A saved scikit-learn model loads reliably only with the version that saved it,
                  so use a fresh virtual environment.
                </>
              ) : (
                "A saved scikit-learn model loads reliably only with the version that saved it, so use a fresh virtual environment."
              )}
            </p>
          </Step>
          <Step n={2} title="Predict from the command line">
            <Snippet code="python predict.py new_rows.csv -o predictions.csv" />
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--lp-ink-3)]">
              Writes one row per input row:{" "}
              {outCols.map((c, i) => (
                <span key={c + i}>
                  {i > 0 && ", "}
                  <code className="font-mono text-[12px] text-[var(--lp-ink-2)]">{c}</code>
                </span>
              ))}
              . Missing columns stop it with a clear message; extra columns are ignored.
            </p>
          </Step>
          <Step n={3} title="Or from Python">
            <Snippet code={PY_USAGE(info?.target ?? "")} />
          </Step>
        </ol>
      )}

      {info && info.features.length > 0 && (
        <div>
          <p className="ws-label mb-2">Columns it expects · {info.features.filter((f) => f.required).length} required</p>
          <div className="max-h-[300px] overflow-auto rounded-md border border-[rgb(var(--lp-ink-rgb)/0.1)]">
            <table className="w-full text-left text-[13px]">
              <thead className="sticky top-0 bg-code text-[11.5px] tracking-wide text-[var(--lp-ink-3)] uppercase">
                <tr>
                  <th className="px-3 py-2 font-medium">Column</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Example</th>
                </tr>
              </thead>
              <tbody>
                {info.features.map((f) => (
                  <tr key={f.name} className="border-t border-[rgb(var(--lp-ink-rgb)/0.07)]">
                    <td className="px-3 py-1.5 font-mono text-[12.5px] text-[var(--lp-ink)]">
                      {f.name}
                      {!f.required && (
                        <span className="ml-2 font-sans text-[11.5px] text-[var(--lp-ink-3)] italic">optional · ID-like; left blank if absent</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--lp-ink-2)]" title={f.dtype}>
                      {typeLabel(f.dtype)}
                    </td>
                    <td className="max-w-[16rem] truncate px-3 py-1.5 font-mono text-[12.5px] text-[var(--lp-ink-2)]">
                      {info.exampleRow[f.name] == null ? <span className="text-[var(--lp-ink-3)] italic">blank</span> : String(info.exampleRow[f.name])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {example && (
            <div className="mt-3">
              <p className="mb-1.5 text-[13px] text-[var(--lp-ink-3)]">new_rows.csv looks like this (one real training row):</p>
              <Snippet code={example} />
            </div>
          )}
        </div>
      )}
      {card && cardText.state === "loading" && <p className="text-[13.5px] text-[var(--lp-ink-3)]">Loading the model card…</p>}

      {pipeline && (
        <details className="group">
          <summary className="ws-label cursor-pointer select-none">{pipeline.name} · how it was trained</summary>
          <div className="mt-2">
            <FileText file={pipeline} />
          </div>
        </details>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] tracking-wide text-[var(--lp-ink-3)] uppercase">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-[var(--lp-ink)]" title={value}>
        {value}
      </dd>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-full font-mono text-[12px] text-[var(--lp-signal)]"
        style={{ boxShadow: "inset 0 0 0 1px var(--lp-signal)" }}
        aria-hidden
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="mb-2 text-[14px] font-medium text-[var(--lp-ink)]">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** A copyable snippet. */
function Snippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-rule bg-code px-3 py-2.5 pr-16 font-mono text-[12.5px] leading-[1.6] text-ink">{code}</pre>
      <button
        type="button"
        className="as-dl"
        style={{ position: "absolute", top: "0.5rem", right: "0.625rem" }}
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
        aria-label="Copy to clipboard"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

/** A text file's contents (code, requirements, the model card). */
function FileText({ file }: { file: AssetFile }) {
  const code = useFileText(file);
  return code.state === "ok" ? (
    <CodeView code={code.text} />
  ) : (
    <p className="text-[13.5px] text-[var(--lp-ink-3)]">
      {code.state === "loading" ? "Loading…" : file.available ? "Couldn't load it here; download it instead." : "Still being prepared."}
    </p>
  );
}

const TEXT_KINDS = new Set(["code", "script", "text", "json"]);

/** A file that isn't the model: its text when it is text, else its size. */
function FilePreview({ file }: { file: AssetFile }) {
  if (TEXT_KINDS.has(file.kind) || /\.(py|txt|json|md)$/i.test(file.name)) return <FileText file={file} />;
  return <p className="text-[14px] text-[var(--lp-ink-2)]">{fmtBytes(file.bytes)}</p>;
}

/**
 * A small text asset's contents, read same-origin through `?inline=1` (the backend reads the bytes itself; a plain
 * download 302s to a private Blob URL on another origin, which a fetch can't read). Downloads keep the plain URL.
 */
function useFileText(file: AssetFile | null): { state: "idle" | "loading" | "ok" | "error"; text: string } {
  const url = file?.available && file.downloadUrl ? `${file.downloadUrl}${file.downloadUrl.includes("?") ? "&" : "?"}inline=1` : null;
  const [res, setRes] = useState<{ url: string | null; state: "loading" | "ok" | "error"; text: string }>({ url: null, state: "loading", text: "" });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    fetch(url, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const t = await r.text();
        if (alive) setRes({ url, state: "ok", text: t.slice(0, 200_000) });
      })
      .catch(() => alive && setRes({ url, state: "error", text: "" }));
    return () => {
      alive = false;
    };
  }, [url]);
  if (!url) return { state: "idle", text: "" };
  return res.url === url ? res : { state: "loading", text: "" };
}

/**
 * A modal sheet over the workspace: native <dialog> + showModal() makes the rest inert (the focus trap) and closes on
 * Escape. Portalled to <body> so it isn't announced as part of the chat log.
 */
function PreviewDialog({
  open,
  origin,
  onClose,
  title,
  sub,
  action,
  children,
}: {
  open: boolean;
  origin: { current: DOMRect | null };
  onClose: () => void;
  title: string;
  sub?: string | null;
  action?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reduced = useReducedMotion();
  const closing = useRef(false);
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- portal target exists only after mount
  useEffect(() => setMounted(true), []);

  /** Where the tile sits relative to the open sheet: the offset and scale that put the sheet over the tile. */
  const fromTile = (d: HTMLDialogElement) => {
    const o = origin.current;
    const r = d.getBoundingClientRect();
    if (!o || !r.width) return { x: 0, y: 12, scale: 0.97 };
    return {
      x: o.left + o.width / 2 - (r.left + r.width / 2),
      y: o.top + o.height / 2 - (r.top + r.height / 2),
      scale: Math.max(0.2, Math.min(0.9, o.width / r.width)),
    };
  };

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      closing.current = false;
      d.showModal();
      if (!reduced) {
        const f = fromTile(d);
        gsap.fromTo(
          d,
          { ...f, opacity: 0, filter: "blur(12px)" },
          { x: 0, y: 0, scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.7, ease: "expo.out", clearProps: "transform,filter,opacity" },
        );
      }
    }
    if (!open && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  /** Settle back into the tile, then close (Escape, the close button and the backdrop all come through here). */
  const requestClose = () => {
    const d = ref.current;
    if (!d || closing.current) return;
    closing.current = true;
    if (reduced) return onClose();
    gsap.to(d, { ...fromTile(d), opacity: 0, filter: "blur(8px)", duration: 0.32, ease: "power3.in", onComplete: onClose });
  };
  if (!mounted) return null;
  return createPortal(
    <dialog
      ref={ref}
      className="as-dialog"
      data-terra
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog box itself, outside the sheet) closes it.
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      {open && (
        <div className="as-sheet">
          <header className="as-sheet-head">
            <div className="min-w-0">
              <h2 id={titleId} className="as-sheet-title">
                {title}
              </h2>
              {sub && <p className="as-sheet-sub">{sub}</p>}
            </div>
            <div className="flex flex-none items-center gap-2">
              {action}
              <button type="button" className="as-close" onClick={requestClose} aria-label="Close preview">
                <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
                  <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </header>
          <div className="as-sheet-body">{children}</div>
        </div>
      )}
    </dialog>,
    document.body,
  );
}
