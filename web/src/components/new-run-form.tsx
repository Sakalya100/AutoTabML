"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MAX_UPLOAD_BYTES, previewCsv, validateRunRequest, type CsvPreview, type LlmChoice } from "@/lib/upload";

const HEAD_BYTES = 64 * 1024;

export function NewRunForm({ maxExperiments, serverKey }: { maxExperiments: number; serverKey: boolean }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [head, setHead] = useState("");
  const [target, setTarget] = useState("");
  const [description, setDescription] = useState("");
  const [maxExp, setMaxExp] = useState(Math.min(10, maxExperiments));
  const [llm, setLlm] = useState<LlmChoice>("heuristic");
  const [apiKey, setApiKey] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);

  const onFile = async (f: File | null) => {
    setErrors({});
    setFile(f);
    setPreview(null);
    setTarget("");
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      setErrors({ file: `The file is ${(f.size / 1048576).toFixed(1)} MB; the limit is 5 MB.` });
      return;
    }
    const text = await f.slice(0, HEAD_BYTES).text();
    setHead(text);
    const p = previewCsv(text, 4);
    setPreview(p);
    // Guess a target: a column named like one, else the last column.
    const guess = p.columns.find((c) => /^(target|label|class|y|outcome|species|variety|price)$/i.test(c)) ?? p.columns.at(-1) ?? "";
    setTarget(guess);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return setErrors({ file: "Choose a CSV file first." });
    const v = validateRunRequest(
      { fileName: file.name, fileBytes: file.size, head, complete: file.size <= HEAD_BYTES, target, description, maxExperiments: maxExp, llm, apiKey: llm === "anthropic" ? apiKey : null },
      { maxExperiments },
    );
    if (!v.ok) return setErrors({ [v.field]: v.error });
    if (llm === "anthropic" && !apiKey && !serverKey) return setErrors({ apiKey: "Paste your Anthropic API key, or use the offline heuristic." });

    setSubmitting(true);
    setErrors({});
    const fd = new FormData();
    fd.set("file", file);
    fd.set("target", target);
    fd.set("description", description);
    fd.set("maxExperiments", String(maxExp));
    fd.set("llm", llm);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        body: fd,
        headers: llm === "anthropic" && apiKey ? { "x-anthropic-api-key": apiKey } : undefined,
      });
      const body = (await res.json()) as { id?: string; error?: string; field?: string };
      if (!res.ok || !body.id) {
        setErrors({ [body.field ?? "form"]: body.error ?? "Something went wrong starting the run." });
        setSubmitting(false);
        return;
      }
      router.push(`/runs/${body.id}`);
    } catch {
      setErrors({ form: "Could not reach the server. Check your connection and try again." });
      setSubmitting(false);
    }
  };

  const field = "w-full rounded-md border border-rule-strong bg-paper px-3 py-2 text-[15px] text-ink placeholder:text-ink-3 focus:border-best focus:outline-none";
  const err = (k: string) => errors[k] && <p className="mt-1.5 text-sm text-crash">{errors[k]}</p>;

  return (
    <form onSubmit={submit} className="mt-10 space-y-8" noValidate>
      <Step n={1} title="Your data">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void onFile(e.dataTransfer.files?.[0] ?? null);
          }}
          className={`flex cursor-pointer flex-col items-start gap-1 rounded-md border border-dashed px-4 py-5 transition-colors ${
            dragging ? "border-best bg-best-soft" : "border-rule-strong hover:border-ink-3"
          }`}
        >
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
          {file ? (
            <>
              <span className="font-mono text-sm">{file.name}</span>
              <span className="text-xs text-ink-3">
                {(file.size / 1024).toFixed(0)} KB · {preview?.columns.length ?? 0} columns · click to replace
              </span>
            </>
          ) : (
            <>
              <span className="text-[15px]">Drop a CSV here, or click to choose one</span>
              <span className="text-xs text-ink-3">Header row required · up to 5 MB</span>
            </>
          )}
        </label>
        {err("file")}
        {preview && preview.columns.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded-md border border-rule">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-paper-2">
                  {preview.columns.map((c) => (
                    <th key={c} className={`px-2 py-1.5 text-left font-mono font-medium whitespace-nowrap ${c === target ? "text-best" : "text-ink-2"}`}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono text-ink-3">
                {preview.rows.map((r, i) => (
                  <tr key={i} className="border-t border-rule">
                    {preview.columns.map((c, j) => (
                      <td key={c} className={`px-2 py-1 whitespace-nowrap ${c === target ? "text-ink" : ""}`}>
                        {r[j] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Step>

      <Step n={2} title="What to predict">
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <div>
            <label htmlFor="target" className="mb-1 block text-sm text-ink-2">
              Target column
            </label>
            <select id="target" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!preview} className={`${field} disabled:opacity-50`}>
              {!preview && <option>Upload a CSV first</option>}
              {preview?.columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {err("target")}
          </div>
          <div>
            <label htmlFor="maxexp" className="mb-1 block text-sm text-ink-2">
              Max experiments
            </label>
            <input id="maxexp" type="number" min={1} max={maxExperiments} value={maxExp} onChange={(e) => setMaxExp(Number(e.target.value))} className={`${field} font-mono tabular`} />
            {err("maxExperiments")}
          </div>
        </div>
        <div className="mt-4">
          <label htmlFor="desc" className="mb-1 block text-sm text-ink-2">
            Describe the problem <span className="text-ink-3">(optional — the agent reads this)</span>
          </label>
          <textarea
            id="desc"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Predict whether a customer churns next month. Recall on churners matters more than precision."
            className={field}
          />
          {err("description")}
        </div>
      </Step>

      <Step n={3} title="Who proposes the ideas">
        <div className="grid gap-3 sm:grid-cols-2">
          <Choice checked={llm === "heuristic"} onChange={() => setLlm("heuristic")} title="Offline heuristic" note="No LLM, no key, free. A fixed playbook of sensible tabular ideas." />
          <Choice checked={llm === "anthropic"} onChange={() => setLlm("anthropic")} title="Anthropic (bring your own key)" note="Claude reads the profile and the ledger and invents each next idea." />
        </div>
        {llm === "anthropic" && (
          <div className="mt-4">
            <label htmlFor="key" className="mb-1 block text-sm text-ink-2">
              Anthropic API key {serverKey && <span className="text-ink-3">(optional — this deployment has a capped demo key)</span>}
            </label>
            <input id="key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" className={`${field} font-mono`} />
            <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
              Sent once, in a request header, and handed to this run only. It is never stored, written to the run record, or logged. Usage is billed
              to your Anthropic account; spend shows in the cost meter.
            </p>
            {err("apiKey")}
          </div>
        )}
        {err("llm")}
      </Step>

      <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-6">
        <button
          type="submit"
          disabled={submitting || !file}
          className="rounded-full bg-ink px-6 py-3 text-[15px] font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {submitting ? "Starting…" : "Start the run"}
        </button>
        <span className="text-sm text-ink-3">You&apos;ll be taken to the live view. Runs are kept for 24 hours.</span>
      </div>
      {err("form")}
    </form>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-3 flex items-baseline gap-3">
        <span className="font-display text-2xl text-best italic">{n}</span>
        <span className="font-display text-2xl">{title}</span>
      </legend>
      {children}
    </fieldset>
  );
}

function Choice({ checked, onChange, title, note }: { checked: boolean; onChange: () => void; title: string; note: string }) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-md border p-4 transition-colors ${checked ? "border-ink bg-paper-2" : "border-rule-strong hover:border-ink-3"}`}>
      <input type="radio" name="llm" checked={checked} onChange={onChange} className="mt-1 accent-[var(--best)]" />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="mt-0.5 block text-sm leading-snug text-ink-2">{note}</span>
      </span>
    </label>
  );
}
