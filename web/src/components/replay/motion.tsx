"use client";

/*
 * The run pages' motion vocabulary, in the house language (expo settles, nothing bouncy):
 *   - useLineReveal: a heading's lines rise out of a mask (GSAP SplitText, re-split on resize and font load);
 *   - ScrambleNumber: a number whose digits scramble and settle left to right, in place (mono, so no layout shift);
 *   - useRevealOnScroll: items get [data-in] as they enter, in batches; CSS (.rv) does the soft rise and the stagger.
 * Every piece is a no-op under prefers-reduced-motion, and content is never hidden before JavaScript runs.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { DUR, EASE, gsap, ScrollTrigger, SplitText, useGSAP } from "@/lib/motion/gsap";
import "./motion.css";

const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;
const NO_MOTION = "(prefers-reduced-motion: reduce)";
const reducedNow = () => typeof window !== "undefined" && window.matchMedia(NO_MOTION).matches;

interface LineRevealOpts {
  /** "mount": play as soon as it renders; "view": when it scrolls into view. */
  on?: "mount" | "view";
  delay?: number;
  stagger?: number;
  duration?: number;
  /** Re-run when this changes (a new message in the same element). */
  key?: unknown;
  /** "none" for headings that wrap links: SplitText's default aria-hides the split lines, links included. */
  aria?: "auto" | "none";
}

/** Masked line reveal for a heading. The element's text stays real text (SplitText keeps an aria-label). */
export function useLineReveal(
  ref: RefObject<HTMLElement | null>,
  { on = "mount", delay = 0, stagger = 0.085, duration = DUR.reveal, key, aria = "auto" }: LineRevealOpts = {},
) {
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        let first = true;
        const split = SplitText.create(el, {
          type: "lines",
          mask: "lines",
          linesClass: "mr-line",
          autoSplit: true,
          aria,
          onSplit(self) {
            // a re-split (resize, late font) shows the settled state; only the first split animates
            if (!first) return;
            first = false;
            el.removeAttribute("data-pre");
            return gsap.from(self.lines, {
              yPercent: 112,
              duration,
              delay,
              stagger,
              ease: EASE.out,
              scrollTrigger: on === "view" ? { trigger: el, start: "top 90%", once: true } : undefined,
            });
          },
        });
        return () => split.revert();
      });
      // reduced motion (or no split at all): never leave the heading hidden
      if (reducedNow()) el.removeAttribute("data-pre");
      return () => mm.revert();
    },
    { dependencies: [key], scope: ref },
  );
}

/** A heading whose lines rise out of a mask. `pre` hides it until split (for headings on screen at first paint). */
export function RevealHeading({
  as: Tag = "h2",
  className,
  id,
  children,
  pre,
  on = "mount",
  delay = 0.04,
}: {
  as?: "h1" | "h2" | "h3" | "p";
  className?: string;
  id?: string;
  children: ReactNode;
  pre?: boolean;
  on?: "mount" | "view";
  delay?: number;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLineReveal(ref, { on, delay, duration: 1.05 });
  return (
    <Tag ref={ref} id={id} className={className} data-pre={pre ? "" : undefined}>
      {children}
    </Tag>
  );
}

/* ---- numbers ---- */

const DIGITS = "0123456789";

interface ScrambleProps {
  value: string;
  className?: string;
  /** "mount": on first render; "view": when it scrolls into view; changes to `value` always re-scramble. */
  on?: "mount" | "view";
  /** Seconds for the whole number to settle. */
  duration?: number;
  delay?: number;
}

/**
 * Digits scramble and settle into place, left to right; punctuation, signs and units stay put, so the width never
 * changes (the run pages set numbers in a tabular mono face). Screen readers get the real value once.
 */
export function ScrambleNumber({ value, className, on = "mount", duration = 0.9, delay = 0 }: ScrambleProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<string | null>(null);
  const [armed, setArmed] = useState(on === "mount");

  useEffect(() => {
    if (on !== "view" || armed) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setArmed(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [on, armed]);

  useIso(() => {
    const el = ref.current;
    if (!el) return;
    if (!armed || reducedNow()) {
      el.textContent = value;
      return;
    }
    const from = prev.current;
    prev.current = value;
    // only the digits that changed move when a value updates in place; everything on first show
    const moving = [...value].map((c, i) => DIGITS.includes(c) && (from == null || from.length !== value.length || from[i] !== c));
    const n = moving.filter(Boolean).length;
    if (!n) {
      el.textContent = value;
      return;
    }
    const t0 = performance.now() + delay * 1000;
    const total = (from == null ? duration : Math.min(duration, 0.55)) * 1000;
    let raf = 0;
    let lastSwap = 0;
    let order = 0;
    const settleAt = [...value].map((_, i) => (moving[i] ? 0.28 + 0.72 * (order++ / Math.max(1, n - 1)) : 0));
    const tick = (now: number) => {
      const p = (now - t0) / total;
      if (p >= 1) {
        el.textContent = value;
        return;
      }
      if (now - lastSwap > 48 || p < 0) {
        lastSwap = now;
        let s = "";
        for (let i = 0; i < value.length; i++) s += moving[i] && (p < 0 || p < settleAt[i]) ? DIGITS[(Math.random() * 10) | 0] : value[i];
        el.textContent = s;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = value;
    };
  }, [value, armed, duration, delay]);

  return (
    <span className={className}>
      <span ref={ref} aria-hidden>
        {value}
      </span>
      <span className="sr-only">{value}</span>
    </span>
  );
}

/* ---- scroll reveals ---- */

/**
 * Everything matching `selector` inside `scope` gets [data-in] as it scrolls into view, in batches; CSS (.rv) does the
 * rise, and `--i` (set here, per batch) the stagger. The scope gets [data-rv-armed] first, so without JavaScript (or
 * with reduced motion) nothing is ever hidden.
 */
export function useRevealOnScroll(scope: RefObject<HTMLElement | null>, selector: string, deps: unknown[] = []) {
  useIso(() => {
    const root = scope.current;
    if (!root) return;
    if (reducedNow()) return;
    root.setAttribute("data-rv-armed", "");
    const els = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hasAttribute("data-in"));
    if (!els.length) return;
    const triggers = ScrollTrigger.batch(els, {
      start: "top 92%",
      once: true,
      onEnter: (batch) =>
        (batch as HTMLElement[]).forEach((el, i) => {
          el.style.setProperty("--i", String(i));
          el.setAttribute("data-in", "");
        }),
    });
    return () => triggers.forEach((t) => t.kill());
    // callers pass what changes the set of items
  }, deps);
}

/** Smoothly scroll the document: through Lenis when it is driving the page, natively otherwise. */
export function scrollDocTo(target: number | HTMLElement, lenis: { scrollTo: (t: number | HTMLElement, o?: object) => void } | undefined, offset = 0) {
  const reduced = reducedNow();
  if (lenis && !reduced) {
    lenis.scrollTo(target, { offset, duration: 1.35, easing: (t: number) => 1 - Math.pow(2, -10 * t) });
    return;
  }
  const top = typeof target === "number" ? target : target.getBoundingClientRect().top + window.scrollY + offset;
  window.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
}
