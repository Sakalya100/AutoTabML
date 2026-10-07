/** Unified-diff and code rendering. No highlighter: line colouring carries the meaning. */

export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="text-sm text-ink-3">No diff — this experiment has no parent (it is the starting point).</p>;
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <pre className="max-h-[520px] overflow-auto rounded-md border border-rule bg-code py-2 font-mono text-[12px] leading-[1.6]">
      {lines.map((l, i) => {
        let cls = "text-ink-2";
        if (l.startsWith("+++") || l.startsWith("---")) cls = "font-semibold text-ink";
        else if (l.startsWith("@@")) cls = "text-select";
        else if (l.startsWith("+")) cls = "bg-[var(--add-bg)] text-ink";
        else if (l.startsWith("-")) cls = "bg-[var(--del-bg)] text-ink";
        return (
          <div key={i} className={`px-3 whitespace-pre ${cls}`}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function CodeView({ code }: { code: string }) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <pre className="max-h-[520px] overflow-auto rounded-md border border-rule bg-code py-2 font-mono text-[12px] leading-[1.6]">
      {lines.map((l, i) => (
        <div key={i} className="flex whitespace-pre">
          <span className="w-10 shrink-0 pr-3 text-right text-ink-3 select-none tabular">{i + 1}</span>
          <span className={l.trimStart().startsWith("#") ? "text-ink-3 italic" : "text-ink"}>{l || " "}</span>
        </div>
      ))}
    </pre>
  );
}
