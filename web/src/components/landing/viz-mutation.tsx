"use client";

import { motion } from "motion/react";
import type { LandingFacts } from "./facts";
import { EASE } from "./primitives";

/** The real idea and the real diff of the mutation that produced this run's winner. */
export function MutationViz({ showcase, gainText }: { showcase: NonNullable<LandingFacts["showcase"]>; gainText: string | null }) {
  return (
    <div className="lp-panel">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[color:var(--lp-ink-3)]">
        <span className="rounded-full border border-white/10 px-2 py-0.5">{showcase.parentId ?? "root"}</span>
        <motion.span
          aria-hidden
          className="inline-block h-px w-8 origin-left bg-[color:var(--lp-keep)]"
          initial={{ scaleX: 0 }}
          whileInView={{ scaleX: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, ease: EASE }}
        />
        <span className="rounded-full border border-[color:var(--lp-keep)]/50 px-2 py-0.5 text-[color:var(--lp-keep)]">{showcase.id}</span>
        <span className="ml-1">{showcase.category.replace(/_/g, " ")}</span>
        {showcase.radical && <span className="rounded-full bg-[color:var(--lp-gold)]/15 px-2 py-0.5 text-[color:var(--lp-gold)]">radical</span>}
      </div>

      <div className="mt-5">
        <div className="lp-micro">hypothesis — written before any code</div>
        <p className="mt-2 font-display text-[clamp(1.45rem,2.4vw,2rem)] leading-[1.12] text-[color:var(--lp-ink)]">{showcase.title}</p>
        {showcase.rationale && <p className="mt-2 text-[15px] italic text-[color:var(--lp-ink-2)]">“{showcase.rationale}”</p>}
      </div>

      <div className="mt-6">
        <div className="lp-micro flex justify-between">
          <span>solution.py · {showcase.parentId} → {showcase.id}</span>
          <span>
            <span className="text-[color:var(--lp-keep)]">+{showcase.diff.filter((d) => d.t === "+").length}</span>{" "}
            <span className="text-[color:var(--lp-crash)]">−{showcase.diff.filter((d) => d.t === "-").length}</span>
          </span>
        </div>
        <pre className="lp-code mt-2" aria-label="diff">
          {showcase.diff.map((d, i) => (
            <motion.div
              key={i}
              className={d.t === "+" ? "lp-add" : "lp-del"}
              initial={{ opacity: 0, x: d.t === "+" ? 14 : -14 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ duration: 0.55, delay: 0.25 + i * 0.09, ease: EASE }}
            >
              <span className="lp-sign">{d.t === "+" ? "+" : "−"}</span>
              {d.s}
            </motion.div>
          ))}
        </pre>
      </div>

      {gainText && (
        <motion.p
          className="mt-4 font-mono text-[11.5px] text-[color:var(--lp-keep)]"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, delay: 0.25 + showcase.diff.length * 0.09 + 0.2 }}
        >
          ✓ {gainText}
        </motion.p>
      )}
    </div>
  );
}
