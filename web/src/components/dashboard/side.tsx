"use client";

/* The side cards: which models did the thinking, which metrics the runs optimised, and what "≈ cost" is based on. */
import { useRef } from "react";
import { fmtCompact, fmtUsd, type DashPricing, type DashProvider } from "@/lib/dashboard";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion/gsap";
import { Mark, metricStyles } from "./honesty";

/** "groq/openai/gpt-oss-120b" → name "gpt-oss-120b", via "Groq". */
function splitModel(m: string): { name: string; via: string | null } {
  const parts = m.split("/");
  const name = parts[parts.length - 1];
  const host = parts.length > 1 ? parts[0] : null;
  const via = host ? host.charAt(0).toUpperCase() + host.slice(1) : null;
  return { name, via };
}

export function ProvidersCard({ providers }: { providers: DashProvider[] }) {
  const root = useRef<HTMLElement>(null);
  const max = Math.max(1, ...providers.map((p) => p.tokens));
  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.from(".dash-bar-fill", {
        scaleX: 0,
        transformOrigin: "0% 50%",
        duration: 1.3,
        ease: EASE.out,
        stagger: 0.1,
        scrollTrigger: { trigger: root.current, start: "top 85%", once: true },
      });
    },
    { scope: root, dependencies: [providers.map((p) => `${p.model}${p.tokens}`).join()] },
  );
  return (
    <section ref={root} className="dash-card dash-providers" aria-labelledby="dash-prov-h">
      <h2 id="dash-prov-h" className="dash-h2">
        Models used
      </h2>
      <p className="dash-card-sub">The language models that proposed the experiments.</p>
      {providers.length === 0 ? (
        <p className="dash-none">No model calls in this window.</p>
      ) : (
        <ul className="dash-bars">
          {providers.map((p, i) => {
            const { name, via } = splitModel(p.model);
            return (
              <li key={p.model} className="dash-bar">
                <div className="dash-bar-top">
                  <span className="dash-bar-name">
                    {name}
                    {via ? <span className="dash-dim"> · {via}</span> : null}
                  </span>
                  <span className="dash-mono dash-bar-val">{fmtCompact(p.tokens)} tok</span>
                </div>
                <div className="dash-bar-track" aria-hidden>
                  <span className="dash-bar-fill" data-first={i === 0 ? "" : undefined} style={{ width: `${Math.max(2, (p.tokens / max) * 100)}%` }} />
                </div>
                <p className="dash-bar-foot dash-mono">
                  {fmtCompact(p.calls)} calls · ≈ {fmtUsd(p.equivCostUsd)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Metric mix as a ring: each arc is one metric's share of runs, in the same colours and shapes as the scatter. */
export function MetricsCard({ metrics }: { metrics: { metric: string; runs: number }[] }) {
  const root = useRef<HTMLElement>(null);
  const style = metricStyles(metrics.map((m) => m.metric));
  const total = metrics.reduce((a, m) => a + m.runs, 0);
  const R = 42;
  const C = 2 * Math.PI * R;
  const GAP = metrics.length > 1 ? 3 : 0;
  const shares = metrics.map((m) => (m.runs / Math.max(1, total)) * C);
  const arcs = metrics.map((m, i) => ({ m, start: shares.slice(0, i).reduce((a, b) => a + b, 0), len: Math.max(0.5, shares[i] - GAP) }));
  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.from(".dash-arc", {
        strokeDasharray: `0 ${C}`,
        duration: 1.4,
        ease: EASE.out,
        stagger: 0.12,
        scrollTrigger: { trigger: root.current, start: "top 85%", once: true },
      });
    },
    { scope: root, dependencies: [metrics.map((m) => `${m.metric}${m.runs}`).join()] },
  );
  return (
    <section ref={root} className="dash-card dash-metrics" aria-labelledby="dash-met-h">
      <h2 id="dash-met-h" className="dash-h2">
        Metrics mix
      </h2>
      <p className="dash-card-sub">What the runs were asked to optimise.</p>
      {metrics.length === 0 ? (
        <p className="dash-none">No runs in this window.</p>
      ) : (
        <div className="dash-ring-wrap">
          <svg viewBox="0 0 110 110" className="dash-ring" role="img" aria-label={metrics.map((m) => `${style(m.metric).label}: ${m.runs}`).join(", ")}>
            <circle cx="55" cy="55" r={R} className="dash-ring-track" />
            {arcs.map(({ m, start, len }) => (
              <circle
                key={m.metric}
                cx="55"
                cy="55"
                r={R}
                className="dash-arc"
                stroke={style(m.metric).color}
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-start}
                transform="rotate(-90 55 55)"
              />
            ))}
            <text x="55" y="52" textAnchor="middle" className="dash-ring-n">
              {total}
            </text>
            <text x="55" y="66" textAnchor="middle" className="dash-ring-l">
              {total === 1 ? "run" : "runs"}
            </text>
          </svg>
          <ul className="dash-ring-legend">
            {metrics.map((m) => {
              const s = style(m.metric);
              return (
                <li key={m.metric}>
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                    <Mark shape={s.shape} x={6} y={6} r={4} color={s.color} />
                  </svg>
                  <span>{s.label}</span>
                  <span className="dash-mono dash-dim">{m.runs}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Tokens in vs out: the split that drives the cost (output tokens cost four times as much). */
export function TokensCard({ tokensIn, tokensOut, pricing }: { tokensIn: number; tokensOut: number; pricing: DashPricing }) {
  const root = useRef<HTMLElement>(null);
  const total = tokensIn + tokensOut;
  const cin = (tokensIn * pricing.input) / 1e6;
  const cout = (tokensOut * pricing.output) / 1e6;
  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.from(".dash-split > span", {
        scaleX: 0,
        transformOrigin: "0% 50%",
        duration: 1.2,
        ease: EASE.out,
        stagger: 0.15,
        scrollTrigger: { trigger: root.current, start: "top 88%", once: true },
      });
    },
    { scope: root, dependencies: [total] },
  );
  return (
    <section ref={root} className="dash-card dash-tokens" aria-labelledby="dash-tok-h">
      <h2 id="dash-tok-h" className="dash-h2">
        Tokens
      </h2>
      <p className="dash-card-sub">
        <span className="dash-mono">{fmtCompact(total)}</span> read and written by the models
        {total > 0 && cin + cout > 0 ? (
          <>
            ; replies are {Math.round((tokensOut / total) * 100)}% of the tokens and {Math.round((cout / (cin + cout)) * 100)}% of the cost.
          </>
        ) : (
          "."
        )}
      </p>
      {total > 0 ? (
        <>
          <div className="dash-split" aria-hidden>
            <span className="dash-split-in" style={{ flex: Math.max(tokensIn, total * 0.02) }} />
            <span className="dash-split-out" style={{ flex: Math.max(tokensOut, total * 0.02) }} />
          </div>
          <div className="dash-split-legend">
            <p>
              In · prompts
              <span className="dash-mono">
                {fmtCompact(tokensIn)} <span className="dash-dim">≈ {fmtUsd(cin)}</span>
              </span>
            </p>
            <p>
              Out · replies
              <span className="dash-mono">
                {fmtCompact(tokensOut)} <span className="dash-dim">≈ {fmtUsd(cout)}</span>
              </span>
            </p>
          </div>
        </>
      ) : (
        <p className="dash-none">No model calls in this window.</p>
      )}
    </section>
  );
}

export function PricingNote({ pricing }: { pricing: DashPricing }) {
  return (
    <aside className="dash-pricing" aria-label="Pricing basis">
      <p className="dash-label">Pricing basis</p>
      <p>
        “≈ cost” is what the tokens would cost on {pricing.provider} {pricing.model}:{" "}
        <span className="dash-mono">
          ${pricing.input} in / ${pricing.output} out
        </span>{" "}
        per million tokens. Runs use free tiers, so the actual spend is <b>$0</b>.
      </p>
    </aside>
  );
}
