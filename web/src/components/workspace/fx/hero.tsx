"use client";

/**
 * The empty state's set pieces: a headline whose lines rise out of masks, and the unsurveyed land in the map column
 * (React Bits' Topography contours, bone on void, leaning toward the cursor). The field is the page's only WebGL
 * context: it exists only while the 3D map is not mounted, runs only while visible, and loses its context on unmount.
 */
import dynamic from "next/dynamic";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EASE, gsap, SplitText, useGSAP } from "@/lib/motion/gsap";

const Topography = dynamic(() => import("@/components/bits/Topography"), { ssr: false });

/** Lines rise from below their own mask, once, after the display face has loaded (so the split matches the final wrap). */
export function RevealTitle({ children, className, delay = 0.1 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();
  const [state, setState] = useState<"pending" | "done">("pending");
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      if (reduced) {
        setState("done");
        return;
      }
      let split: SplitText | null = null;
      let alive = true;
      // Never leave the headline hidden: if fonts stall, show it as is.
      const safety = setTimeout(() => alive && setState("done"), 1800);
      void document.fonts.ready.then(() => {
        if (!alive) return;
        clearTimeout(safety);
        split = SplitText.create(el, {
          type: "lines",
          mask: "lines",
          linesClass: "fx-line",
          onSplit(self) {
            // Room for the italic descenders inside each mask.
            for (const m of self.masks) (m as HTMLElement).style.paddingBottom = "0.14em";
            for (const m of self.masks) (m as HTMLElement).style.marginBottom = "-0.14em";
            setState("done");
            return gsap.from(self.lines, { yPercent: 115, rotate: 1.2, transformOrigin: "0% 100%", duration: 1.25, ease: EASE.out, stagger: 0.12, delay });
          },
        });
      });
      return () => {
        alive = false;
        clearTimeout(safety);
        split?.revert();
      };
    },
    { dependencies: [reduced], scope: ref },
  );
  return (
    <h1 ref={ref} className={className} data-reveal={state}>
      {children}
    </h1>
  );
}

const DESKTOP = "(min-width: 1024px)";

/**
 * The contour field for an empty map column. Mounted only where the column is on screen (desktop, or the phone's Map
 * tab), so a hidden column never holds a GL context; `busy` (a link being read) brightens it. Speed never changes: the
 * shader's phase is time × speed, so changing it mid-flight would jump the whole field.
 */
export function ContourField({ visibleOnPhone, busy }: { visibleOnPhone: boolean; busy: boolean }) {
  const reduced = useReducedMotion();
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const on = () => setDesktop(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // Reduced motion: no drifting field at all (a static frame would still cost a render loop).
  if (reduced || desktop === null || (!desktop && !visibleOnPhone)) return null;
  return (
    <div className="fx-contours" aria-hidden data-busy={busy || undefined}>
      <Topography
        lowColor="#1a1d22"
        midColor="#6f6b63"
        highColor="#ece7dc"
        colorMode="elevation"
        speed={0.22}
        morphSpeed={0.04}
        morphAmount={2.4}
        bands={4.5}
        thickness={0.012}
        glow={0.35}
        contrast={2.6}
        brightness={0.9}
        scale={1.15}
        opacity={0.55}
        grain={false}
        mouseInteraction
        mouseRadius={0.22}
        mouseStrength={0.32}
      />
    </div>
  );
}
