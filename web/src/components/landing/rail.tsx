"use client";

import { motion, useScroll, useSpring } from "motion/react";
import type { SceneChapter } from "@/lib/scene/contract";

export interface RailItem {
  id: string;
  chapter: SceneChapter;
  label: string;
}

/** Scroll progress rail: a depth gauge from the abyss (top) to shipping (bottom), labelled with the chapters. */
export function Rail({ items, active }: { items: RailItem[]; active: string }) {
  const { scrollYProgress } = useScroll();
  const scaleY = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 });
  return (
    <>
      <nav className="lp-rail" aria-label="Sections">
        <div className="lp-rail-track" aria-hidden>
          <motion.div className="lp-rail-fill" style={{ scaleY }} />
        </div>
        <ol>
          {items.map((it, i) => (
            <li key={it.id}>
              <a href={`#${it.id}`} data-active={active === it.id || undefined} aria-current={active === it.id ? "step" : undefined}>
                <span className="lp-rail-label">{it.label}</span>
                <span className="lp-rail-n">{String(i).padStart(2, "0")}</span>
                <span className="lp-rail-tick" aria-hidden />
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <motion.div className="lp-topbar" style={{ scaleX: scaleY }} aria-hidden />
    </>
  );
}
