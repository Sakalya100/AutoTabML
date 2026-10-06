import { fmtCost, fmtDuration, fmtValue, SIGNAL_LABEL, STOP_REASON_LABEL } from "@/lib/format";
import { describeGap, formatScore } from "@/lib/metrics";
import type { RunView } from "@/lib/run-state";

export function StopReport({ view }: { view: RunView }) {
  const stop = view.stop;
  return (
    <section aria-labelledby="stop-h" className="rounded-md border border-rule p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="stop-h" className="font-display text-2xl leading-none">
          Why it stopped
        </h2>
        {stop && <span className="text-xs font-medium uppercase tracking-[0.1em] text-best">{STOP_REASON_LABEL[stop.reason] ?? stop.reason}</span>}
      </div>
      {!stop ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-3">
          The run stops on its own when all four ceiling signals agree (or a budget runs out). Each signal&apos;s value and threshold will be shown
          here with the reasoning.
        </p>
      ) : (
        <>
          <p className="mt-3 text-[15px] leading-relaxed text-ink">{stop.summary}</p>
          <ol className="mt-4 divide-y divide-rule border-y border-rule">
            {stop.signals.map((s) => {
              const meta = SIGNAL_LABEL[s.key] ?? { title: s.key.replace(/_/g, " "), blurb: "" };
              const state = s.fired === true ? "fired" : s.fired === false ? "not fired" : "n/a";
              return (
                <li key={s.key} className="grid grid-cols-[auto_1fr] gap-x-3 py-3 sm:grid-cols-[auto_1fr_auto]">
                  <span
                    aria-hidden
                    className={`mt-1 size-3 rounded-full ${s.fired === true ? "bg-best" : s.fired === false ? "border-2 border-ink-3" : "border border-dashed border-ink-3"}`}
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{meta.title}</span>
                      <span className={`text-xs ${s.fired ? "text-best" : "text-ink-3"}`}>{state}</span>
                    </div>
                    <p className="mt-0.5 text-sm leading-snug text-ink-2">{s.detail || meta.blurb}</p>
                  </div>
                  <div className="col-start-2 mt-1 font-mono text-xs text-ink-2 tabular sm:col-start-3 sm:mt-0 sm:text-right">
                    {fmtValue(s.value)} <span className="text-ink-3">vs</span> {fmtValue(s.threshold)}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

export function FinalScores({ view }: { view: RunView }) {
  const f = view.final;
  const m = view.metric;
  return (
    <section aria-labelledby="final-h" className="rounded-md border border-rule p-4 sm:p-5">
      <h2 id="final-h" className="font-display text-2xl leading-none">
        Locked test &amp; optimism gap
      </h2>
      {!f ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-3">
          The test split is locked away from the agent and the gate. It is scored exactly once, on the final best solution, so the gap between the
          selection score and the test score measures how much the search overfit.
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-3 gap-3">
            <Score label="dev CV" hint="best solution, repeated k-fold" value={formatScore(m, f.devCvMean)} />
            <Score label="select" hint="holdout the gate used" value={formatScore(m, f.selectScore)} color="text-select" />
            <Score label="test" hint="locked, scored once" value={formatScore(m, f.testScore)} strong />
          </dl>
          <div className="mt-4 border-t border-rule pt-3">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-3">optimism gap</span>
              <span className="font-mono text-lg tabular">{Math.abs(f.optimismGap).toFixed(4)}</span>
            </div>
            <p className="mt-1 text-sm text-ink-2">{describeGap(m, f.optimismGap)}.</p>
          </div>
          <p className="mt-3 text-xs text-ink-3">
            {f.nExperiments} experiments · {fmtDuration(f.wallTimeS)} · {fmtCost(f.totalCostUsd)} · best = {f.bestExpId}
          </p>
        </>
      )}
    </section>
  );
}

function Score({ label, hint, value, color, strong }: { label: string; hint: string; value: string; color?: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-3">{label}</dt>
      <dd className={`font-mono text-xl tabular sm:text-2xl ${color ?? "text-ink"} ${strong ? "font-semibold" : ""}`}>{value}</dd>
      <dd className="text-[11px] leading-tight text-ink-3">{hint}</dd>
    </div>
  );
}
