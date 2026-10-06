"use client";

import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import type { ReplayInfo } from "@/lib/replays";
import type { RunView } from "@/lib/run-state";
import { PosterQueue, SurveyPoster } from "./survey-posters";
import "./terra.css";

export interface GalleryItem {
  info: ReplayInfo;
  /** Slimmed view (no code, diffs, rationale): enough to map the survey. */
  view: RunView;
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

const EASE = [0.22, 1, 0.36, 1] as const;

export function ReplayGallery({ items }: { items: GalleryItem[] }) {
  const reduced = useReducedMotion();
  return (
    <PosterQueue>
      <ul className="mt-14 grid grid-cols-1 gap-x-8 gap-y-14 md:grid-cols-2">
        {items.map((it, i) => {
          const [name, proposer] = splitTitle(it.info.title);
          return (
            <motion.li
              key={it.info.name}
              initial={reduced ? false : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, delay: 0.1 + i * 0.1, ease: EASE }}
            >
              <Link href={`/replays/${it.info.name}`} className="group block rounded-xl outline-offset-4 focus-visible:outline-2" aria-label={`${name} replay — ${it.summary}`}>
                <div className="terra-frame relative aspect-[16/10] overflow-hidden rounded-xl transition-shadow duration-700 group-hover:shadow-[0_0_0_1px_rgb(255_181_71/0.35),0_40px_90px_-50px_rgb(5_7_10/0.8)]">
                  <div className="absolute inset-0 transition-transform duration-[1200ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.025] motion-reduce:transform-none">
                    <SurveyPoster cacheKey={`${it.info.name}:${it.info.n_experiments}`} view={it.view} label={it.summary} className="absolute inset-0" />
                  </div>
                  <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#05070a]/90 to-transparent" />
                  <p className="pointer-events-none absolute top-3 left-4 font-mono text-[10px] uppercase tracking-[0.2em] text-[#d9d3c4]/50">
                    chart · {String(i + 1).padStart(2, "0")}
                  </p>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 px-4 pb-3 font-mono text-[11px] text-[#d9d3c4]/70 tabular">
                    <span>
                      best <span className="text-[#ffb547]">{it.best ?? "—"}</span>
                      {it.test && <span> · test <span className="text-[#eaf6ff]">{it.test}</span></span>}
                    </span>
                    <span className="uppercase tracking-[0.14em] text-[#d9d3c4]/55">stopped · {it.info.stop_reason}</span>
                  </div>
                </div>

                <div className="mt-4 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="font-display text-[1.9rem] leading-none tracking-tight transition-colors duration-300 group-hover:text-best">{name}</h2>
                    <p className="mt-1.5 text-sm text-ink-2">{it.info.dataset}</p>
                  </div>
                  <span
                    aria-hidden
                    className="mt-1 grid size-9 shrink-0 place-items-center rounded-full border border-rule-strong text-ink-2 transition-[transform,color,border-color] duration-300 group-hover:translate-x-0.5 group-hover:border-best group-hover:text-best"
                  >
                    <svg viewBox="0 0 16 16" className="size-3.5">
                      <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
                    </svg>
                  </span>
                </div>
                <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-rule pt-3 font-mono text-xs text-ink-3 tabular">
                  <div className="flex gap-1.5">
                    <dt>{it.metricLabel}</dt>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>experiments</dt>
                    <dd className="text-ink">{it.info.n_experiments}</dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>kept</dt>
                    <dd className="text-keep">{it.kept}</dd>
                  </div>
                  {proposer && <dd className="basis-full sm:ml-auto sm:basis-auto">{proposer}</dd>}
                </dl>
              </Link>
            </motion.li>
          );
        })}
      </ul>
    </PosterQueue>
  );
}
