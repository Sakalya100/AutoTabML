"use client";

/*
 * The atlas: every recorded run as its land seen from straight above, one per screen, in the landing's language —
 * the chart floats on the void (no card, no frame), one plain sentence of what happened, one number, one way in.
 * Posters are rendered one at a time by a single WebGL context and cached as images (./survey-posters).
 * Motion: the title's lines rise out of a mask; each land surfaces from the void as its entry scrolls in (a widening
 * survey light), its copy settles in a stagger and its numbers scramble into place; the chart leans toward the cursor
 * and a soft light follows the pointer across it.
 */

import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import Link from "next/link";
import { useRef, type PointerEvent, type ReactNode } from "react";
import { useWebGLAvailable } from "@/lib/gl";
import { EASE, gsap, useGSAP } from "@/lib/motion/gsap";
import type { RunView } from "@/lib/run-state";
import { EvolutionChart } from "./evolution-chart";
import { MagneticLink } from "./landing/primitives";
import { ScrambleNumber, useLineReveal } from "./replay/motion";
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
  /** How this run was picked from several recordings, when it was. */
  selection?: string | null;
}

/** The page head: the title's lines rise out of a mask on arrival, the lines under it settle after. */
export function GalleryHead({ children, sub }: { children: ReactNode; sub: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useLineReveal(title, { delay: 0.1, stagger: 0.1 });
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(".at-head-seq", { y: 18, autoAlpha: 0, duration: 1.1, ease: EASE.out, stagger: 0.09, delay: 0.5 });
      });
      return () => mm.revert();
    },
    { scope: root },
  );
  return (
    <header ref={root} className="at-head">
      <p className="rp-kicker at-head-seq" data-pre="">
        Replays
      </p>
      <h1 ref={title} className="at-h1" data-pre="">
        {children}
      </h1>
      <div className="at-head-seq" data-pre="">
        {sub}
      </div>
    </header>
  );
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
  const title = useRef<HTMLHeadingElement>(null);
  const href = `/replays/${it.name}`;

  // Gentle parallax: the land drifts a little slower than the page.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const drift = useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [36, -36]);

  // Arrival: the title's lines rise, the copy settles in order, the land surfaces from the void like a widening lamp.
  useLineReveal(title, { on: "view", delay: 0.05, aria: "none" });
  useGSAP(
    () => {
      const li = ref.current;
      if (!li) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const trigger = { trigger: li, start: "top 78%", once: true };
        gsap.from(li.querySelectorAll(".at-seq"), { y: 22, autoAlpha: 0, duration: 1.15, ease: EASE.out, stagger: 0.08, delay: 0.2, scrollTrigger: trigger });
        // the stat's hairline draws in from the left as its number settles
        gsap.fromTo(li.querySelectorAll(".at-stat"), { "--draw": 0 }, { "--draw": 1, duration: 1.6, ease: EASE.out, delay: 0.45, scrollTrigger: trigger });
        const land = li.querySelector(".at-reveal");
        if (land)
          gsap.fromTo(
            land,
            { clipPath: "circle(16% at 52% 50%)", scale: 1.07, autoAlpha: 0 },
            { clipPath: "circle(72% at 52% 50%)", scale: 1, autoAlpha: 1, duration: 2, ease: EASE.out, clearProps: "clipPath,scale", scrollTrigger: trigger },
          );
      });
      return () => mm.revert();
    },
    { scope: ref },
  );

  // Pointer tilt: the chart leans a few degrees toward the cursor, like a sheet picked up off a table; a soft light
  // follows the pointer across the land (compositor-only: a transform driven by two custom properties).
  const rx = useSpring(0, { stiffness: 120, damping: 18, mass: 0.6 });
  const ry = useSpring(0, { stiffness: 120, damping: 18, mass: 0.6 });
  const onMove = (e: PointerEvent<HTMLAnchorElement>) => {
    if (reduced || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    ry.set(x * 7);
    rx.set(-y * 6);
    e.currentTarget.style.setProperty("--gx", `${(x + 0.5) * r.width}px`);
    e.currentTarget.style.setProperty("--gy", `${(y + 0.5) * r.height}px`);
    e.currentTarget.setAttribute("data-lit", "");
  };
  const reset = (e: PointerEvent<HTMLAnchorElement>) => {
    rx.set(0);
    ry.set(0);
    e.currentTarget.removeAttribute("data-lit");
  };

  return (
    <li ref={ref} className="at-entry">
      <div className="at-copy">
        <p className="rp-kicker at-seq" data-pre="">
          {String(i + 1).padStart(2, "0")} <span className="at-of">/ {String(n).padStart(2, "0")}</span>
        </p>
        <h2 ref={title} className="at-h2" data-pre="">
          <Link href={href}>{it.title}</Link>
        </h2>
        <p className="at-outcome at-seq" data-pre="">
          {it.outcome}.
        </p>
        {it.test && (
          <div className="lp-stat at-stat at-seq" data-pre="">
            <ScrambleNumber className="lp-stat-v" value={it.test} on="view" delay={0.55} duration={1.1} />
            <span className="lp-stat-k">{it.metricLabel} on data it never saw</span>
          </div>
        )}
        {it.asked && (
          <p className="at-asked at-seq" data-pre="">
            {it.asked}
          </p>
        )}
        <div className="lp-ctas at-ctas at-seq" data-pre="">
          <MagneticLink href={href}>Explore the map</MagneticLink>
          <MagneticLink href={`${href}?simulate`} variant="ghost">
            Watch it run
          </MagneticLink>
        </div>
        {it.selection && (
          <p className="rp-note at-seq" data-pre="">
            {it.selection}
          </p>
        )}
        {it.note && (
          <p className="rp-note at-seq" data-pre="">
            {it.note}
          </p>
        )}
      </div>

      {webgl === false ? (
        <div className="at-fallback at-reveal">
          <EvolutionChart view={it.view} domainView={it.view} plannedExperiments={it.nExperiments} compact />
        </div>
      ) : (
        <motion.div className="at-poster-wrap" style={{ y: drift }}>
          <div className="at-reveal" data-pre="">
            <Link href={href} className="at-poster" onPointerMove={onMove} onPointerLeave={reset} aria-label={`Explore the ${it.title} run`} tabIndex={-1}>
              <motion.div className="at-tilt" style={{ rotateX: rx, rotateY: ry, transformPerspective: 1400 }}>
                <SurveyPoster cacheKey={`atlas-v1:${it.name}:${it.nExperiments}`} view={it.view} label={it.summary} className="absolute inset-0" />
                <span className="at-glare" aria-hidden />
              </motion.div>
            </Link>
          </div>
        </motion.div>
      )}
    </li>
  );
}
