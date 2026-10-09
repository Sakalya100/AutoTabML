"use client";

/**
 * The run's assets, after the report: one tile per chart (with a thumbnail) and one per file (name, size, Download).
 * A tile opens a preview over the workspace: the chart in full, or for the model how to load it plus its pipeline code.
 * Downloads come from GET /api/runs/{id}/assets; until a file is listed as available it reads "preparing…".
 */
import { useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fmtBytes, mergeFiles, parseAssetsListing, type AssetChart, type AssetFile } from "@/lib/assets";
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
  const pipeline = files.find((f) => f.kind === "code" || /\.py$/i.test(f.name)) ?? null;
  // Looked up by name on every render, so a preview opened while "preparing…" turns into a download when ready.
  const previewFile = preview?.kind === "file" ? (files.find((f) => f.name === preview.name) ?? null) : null;
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
        title={!preview ? "" : preview.kind === "cv" ? "CV score per experiment" : preview.kind === "chart" ? preview.chart.title : preview.name}
        sub={
          !preview
            ? null
            : preview.kind === "cv"
              ? "Every scored experiment, with ± 1 standard error. Filled: kept by the gate."
              : preview.kind === "chart"
                ? preview.chart.note
                : previewFile && fileBlurb(previewFile)
        }
        action={previewFile ? <DownloadLink file={previewFile} primary /> : null}
      >
        {preview?.kind === "cv" && <ChartView chart="cv" cv={it.cv} metric={metric} />}
        {preview?.kind === "chart" && <ChartView chart={preview.chart} />}
        {previewFile && <FilePreview file={previewFile} pipeline={pipeline} />}
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

function fileBlurb(f: AssetFile): string {
  if (f.kind === "model") return "The best model, fitted on the training data. Load it with joblib and call predict on a table with the same columns.";
  if (f.kind === "code") return "The training pipeline the best model came from, as a runnable script.";
  return f.note ?? "";
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
      <span className="as-tile-sub">
        {[file.kind === "model" ? "model" : file.kind === "code" ? "code" : null, fmtBytes(file.bytes)].filter(Boolean).join(" · ")}
      </span>
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
      {kind === "code" && (
        <path d="m14 15-3 3 3 3M19 15l3 3-3 3" fill="none" stroke="var(--lp-signal)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

const USAGE = (name: string) => `import joblib
import pandas as pd

model = joblib.load("${name}")
df = pd.read_csv("new_rows.csv")  # same columns as the training data, without the target
predictions = model.predict(df)`;

/** The model: how to use it, and the pipeline it came from. A code file: its source. */
function FilePreview({ file, pipeline }: { file: AssetFile; pipeline: AssetFile | null }) {
  const source = file.kind === "model" ? pipeline : file.kind === "code" || /\.py$/i.test(file.name) ? file : null;
  const code = useFileText(source);
  return (
    <div className="space-y-5">
      {file.kind === "model" && (
        <div>
          <p className="ws-label mb-2">Use it</p>
          <CodeView code={USAGE(file.name)} />
        </div>
      )}
      {source && (
        <div>
          <p className="ws-label mb-2">{file.kind === "model" ? `${source.name} · how it was trained` : source.name}</p>
          {code.state === "ok" ? (
            <CodeView code={code.text} />
          ) : (
            <p className="text-[13.5px] text-[var(--lp-ink-3)]">
              {code.state === "loading"
                ? "Loading the code…"
                : source.available
                  ? "Couldn't load the code here; download it instead."
                  : "The code is still being prepared."}
            </p>
          )}
        </div>
      )}
      {!source && file.kind !== "model" && <p className="text-[14px] text-[var(--lp-ink-2)]">{fmtBytes(file.bytes)}</p>}
    </div>
  );
}

function useFileText(file: AssetFile | null): { state: "idle" | "loading" | "ok" | "error"; text: string } {
  const url = file?.available ? file.downloadUrl : null;
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
