"use client";

/*
 * The atlas: every recorded run as its land seen from straight above, one per screen, in the landing's language —
 * the chart floats on the void (no card, no frame), one plain sentence of what happened, one number, one way in.
 * Posters are rendered one at a time by a single WebGL context and cached as images (./survey-posters).
 */

import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import Link from "next/link";
import { useRef, type PointerEvent } from "react";
import { useWebGLAvailable } from "@/lib/gl";
import type { RunView } from "@/lib/run-state";
import { EvolutionChart } from "./evolution-chart";
import { EASE, MagneticLink } from "./landing/primitives";
import { PosterQueue, SurveyPoster } from "./survey-posters";
import "./terra.css";
import "./replay/replay.css";

export interface GalleryItem {
  name: string;
  /** "Breast cancer" */
  title: string;
  /** Slimmed view (no code, diffs, rationale): enough to map the survey. */
  view: RunView;
  /** Screen-reader summary of the map. */
  summary: string;
  /** "37 ideas tried, 4 kept, stopped on its own" */
  outcome: string;
  /** "Predict malignant (yes or no) from 30 columns of 569 rows" */
  asked: string | null;
  test: string | null;
  metricLabel: string;
  nExperiments: number;
  /** Shown only when it differs from the page's note. */
  note: string | null;
}

export function ReplayGallery({ items }: { items: GalleryItem[] }) {
  return (
    <PosterQueue>
      <ol className="at-list">
        {items.map((it, i) => (
          <AtlasEntry key={it.name} it={it} i={i} n={items.length} />
        ))}
      </ol>
    </PosterQueue>
  );
}

function AtlasEntry({ it, i, n }: { it: GalleryItem; i: number; n: number }) {
  const reduced = useReducedMotion();
  const webgl = useWebGLAvailable();
  const ref = useRef<HTMLLIElement>(null);
  const href = `/replays/${it.name}`;

  // Gentle parallax: the land drifts a little slower than the page.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const drift = useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [36, -36]);

  // Pointer tilt: the chart leans a few degrees toward the cursor, like a sheet picked up off a table.
  const rx = useSpring(0, { stiffness: 120, damping: 18, mass: 0.6 });
  const ry = useSpring(0, { stiffness: 120, damping: 18, mass: 0.6 });
  const onMove = (e: PointerEvent<HTMLAnchorElement>) => {
    if (reduced || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    ry.set(x * 7);
    rx.set(-y * 6);
  };
  const reset = () => {
    rx.set(0);
    ry.set(0);
  };

  return (
    <li ref={ref} className="at-entry">
      <motion.div
        className="at-copy"
        initial={reduced ? false : { opacity: 0, y: 18 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.35 }}
        transition={{ duration: 0.9, ease: EASE }}
      >
        <p className="rp-kicker">
          {String(i + 1).padStart(2, "0")} <span className="at-of">/ {String(n).padStart(2, "0")}</span>
        </p>
        <h2 className="at-h2">
          <Link href={href}>{it.title}</Link>
        </h2>
        <p className="at-outcome">{it.outcome}.</p>
        {it.test && (
          <div className="lp-stat at-stat">
            <span className="lp-stat-v">{it.test}</span>
            <span className="lp-stat-k">{it.metricLabel} on data it never saw</span>
          </div>
        )}
        {it.asked && <p className="at-asked">{it.asked}</p>}
        <div className="lp-ctas at-ctas">
          <MagneticLink href={href}>Explore the map</MagneticLink>
          <MagneticLink href={`${href}?simulate`} variant="ghost">
            Watch it run
          </MagneticLink>
        </div>
        {it.note && <p className="rp-note">{it.note}</p>}
      </motion.div>

      {webgl === false ? (
        <div className="at-fallback">
          <EvolutionChart view={it.view} domainView={it.view} plannedExperiments={it.nExperiments} compact />
        </div>
      ) : (
        <motion.div className="at-poster-wrap" style={{ y: drift }}>
          <motion.div
            initial={reduced ? false : { opacity: 0, scale: 0.97 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 1.4, ease: EASE }}
          >
            <Link href={href} className="at-poster" onPointerMove={onMove} onPointerLeave={reset} aria-label={`Explore the ${it.title} run`} tabIndex={-1}>
              <motion.div className="at-tilt" style={{ rotateX: rx, rotateY: ry }}>
                <SurveyPoster cacheKey={`atlas-v1:${it.name}:${it.nExperiments}`} view={it.view} label={it.summary} className="absolute inset-0" />
              </motion.div>
            </Link>
          </motion.div>
        </motion.div>
      )}
    </li>
  );
}
