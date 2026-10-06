import type { DataProfile } from "@/lib/schema";

const FLAG_TONE: Record<string, string> = {
  possible_target_leak: "border-crash/50 text-crash bg-crash/10",
  id_like: "border-best/40 text-best bg-best-soft",
  high_cardinality: "border-best/40 text-best bg-best-soft",
};

export function DataProfilePanel({ profile }: { profile: DataProfile | null }) {
  if (!profile) return null;
  const ts = profile.target_summary as Record<string, unknown>;
  const counts = (ts.class_counts ?? null) as Record<string, number> | null;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <section aria-labelledby="profile-h">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="profile-h" className="font-display text-2xl leading-none">
          What the agent was shown
        </h2>
        <p className="text-xs text-ink-3">A code-generated profile and at most 5 sample rows — never the full data.</p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="overflow-x-auto rounded-md border border-rule">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-rule bg-paper-2 text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                <th className="py-2 pr-2 pl-3 font-medium">column</th>
                <th className="px-2 py-2 font-medium">kind</th>
                <th className="px-2 py-2 text-right font-medium">missing</th>
                <th className="px-2 py-2 text-right font-medium">unique</th>
                <th className="py-2 pr-3 pl-2 font-medium">flags</th>
              </tr>
            </thead>
            <tbody>
              {profile.columns.map((c) => (
                <tr key={c.name} className="border-b border-rule last:border-b-0">
                  <td className="py-2 pr-2 pl-3 font-mono text-xs">{c.name}</td>
                  <td className="px-2 py-2 text-ink-2">
                    {c.kind} <span className="font-mono text-[10px] text-ink-3">{c.dtype}</span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-xs tabular">
                    <span className={c.missing_frac > 0 ? "text-ink" : "text-ink-3"}>{(c.missing_frac * 100).toFixed(c.missing_frac > 0 && c.missing_frac < 0.01 ? 1 : 0)}%</span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-xs tabular">{c.n_unique}</td>
                  <td className="py-2 pr-3 pl-2">
                    <div className="flex flex-wrap gap-1">
                      {(c.flags ?? []).length === 0 && <span className="text-ink-3">—</span>}
                      {(c.flags ?? []).map((f) => (
                        <span key={f} className={`rounded-full border px-2 py-px text-[11px] ${FLAG_TONE[f] ?? "border-rule-strong text-ink-2"}`}>
                          {f.replace(/_/g, " ")}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-[11px] text-ink-3">rows × columns</dt>
              <dd className="font-mono tabular">
                {profile.n_rows.toLocaleString()} × {profile.n_cols}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-ink-3">task</dt>
              <dd>{profile.problem_type}</dd>
            </div>
          </dl>
          <div>
            <div className="text-[11px] text-ink-3">
              target <span className="font-mono text-ink">{profile.target}</span>
            </div>
            {counts ? (
              <ul className="mt-2 space-y-1.5">
                {Object.entries(counts).map(([k, n]) => (
                  <li key={k} className="grid grid-cols-[1fr_auto] items-center gap-x-2">
                    <span className="truncate text-xs">{k}</span>
                    <span className="font-mono text-xs text-ink-3 tabular">{n}</span>
                    <span className="col-span-2 h-1 rounded-full bg-paper-3">
                      <span className="block h-1 rounded-full bg-ink-2" style={{ width: `${(n / total) * 100}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <pre className="mt-1 overflow-x-auto font-mono text-xs text-ink-2">{JSON.stringify(ts, null, 1)}</pre>
            )}
          </div>
          {profile.warnings?.length ? (
            <ul className="space-y-1 rounded-md bg-paper-2 px-3 py-2 text-xs leading-snug text-ink-2">
              {profile.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
