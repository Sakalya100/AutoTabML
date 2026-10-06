"use client";

import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import type { ReplayInfo } from "@/lib/replays";
import type { RunView } from "@/lib/run-state";
import type { ReefLayout } from "@/lib/scene/contract";
import type { ColumnKind } from "@/lib/schema";
import { ReefGallery, ReefThumbnail } from "./reef/reef-gallery";

export interface GalleryItem {
  info: ReplayInfo;
  layout: ReefLayout;
  phase: RunView["phase"];
  kinds: ColumnKind[];
  summary: string;
  metricLabel: string;
  best: string | null;
  test: string | null;
  kept: number;
}

/** "Housing — offline heuristic proposer (no LLM)" → ["Housing", "offline heuristic proposer (no LLM)"]. */
function splitTitle(t: string): [string, string | null] {
  const i = t.indexOf(" — ");
  return i === -1 ? [t, null] : [t.slice(0, i), t.slice(i + 3)];
}

export function ReplayGallery({ items }: { items: GalleryItem[] }) {
  const reduced = useReducedMotion();
  return (
    <ReefGallery className="mt-12">
      <ul className="grid grid-cols-1 gap-x-6 gap-y-10 md:grid-cols-2">
        {items.map((it, i) => {
          const [name, proposer] = splitTitle(it.info.title);
          return (
            <motion.li
              key={it.info.name}
              initial={reduced ? false : { opacity: 0, y: 28 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.08 + i * 0.09, ease: [0.22, 1, 0.36, 1] }}
            >
              <motion.div whileHover={reduced ? undefined : { y: -6 }} transition={{ type: "spring", stiffness: 260, damping: 24 }}>
                <Link
                  href={`/replays/${it.info.name}`}
                  className="group block rounded-2xl outline-offset-4 focus-visible:outline-2"
                  aria-label={`${name} replay — ${it.summary}`}
                >
                  <div className="relative aspect-[16/10] rounded-2xl border border-rule shadow-[0_24px_60px_-36px_rgba(3,6,13,0.75)] transition-shadow duration-500 group-hover:shadow-[0_34px_80px_-34px_rgba(3,6,13,0.9)]">
                    <ReefThumbnail layout={it.layout} phase={it.phase} columnKinds={it.kinds} label={it.summary} className="absolute inset-0 rounded-2xl" />
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-3 rounded-b-2xl bg-gradient-to-t from-[#03060d]/85 via-[#03060d]/30 to-transparent px-4 pt-10 pb-3">
                      <span className="font-mono text-[11px] text-[#bcd3df]">
                        {it.metricLabel} <span className="text-[#ffd27a]">{it.best ?? "—"}</span>
                        {it.test && <span className="text-[#8fb3c7]"> · test {it.test}</span>}
                      </span>
                      <span className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#cfe3ee]">
                        stopped: {it.info.stop_reason}
                      </span>
                    </div>
                  </div>
                  <div className="mt-4 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h2 className="font-display text-[1.9rem] leading-none tracking-tight transition-colors group-hover:text-best">{name}</h2>
                      <p className="mt-1.5 text-sm text-ink-2">{it.info.dataset}</p>
                    </div>
                    <span
                      aria-hidden
                      className="mt-1 grid size-9 shrink-0 place-items-center rounded-full border border-rule text-ink-2 transition-all duration-300 group-hover:translate-x-0.5 group-hover:border-rule-strong group-hover:text-ink"
                    >
                      <svg viewBox="0 0 16 16" className="size-3.5">
                        <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
                      </svg>
                    </span>
                  </div>
                  <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-rule pt-3 font-mono text-xs text-ink-3">
                    <div className="flex gap-1.5">
                      <dt>experiments</dt>
                      <dd className="text-ink">{it.info.n_experiments}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt>kept</dt>
                      <dd className="text-keep">{it.kept}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt>metric</dt>
                      <dd className="text-ink">{it.info.metric}</dd>
                    </div>
                    {proposer && <dd className="basis-full text-ink-3 sm:ml-auto sm:basis-auto">{proposer}</dd>}
                  </dl>
                </Link>
              </motion.div>
            </motion.li>
          );
        })}
      </ul>
    </ReefGallery>
  );
}
