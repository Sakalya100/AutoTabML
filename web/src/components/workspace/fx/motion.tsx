"use client";

/**
 * The workspace's motion primitives. Every effect here is decorative: the real value is always in the DOM for
 * assistive tech (animated text sits in an aria-hidden span beside a visually hidden copy), reduced motion skips to the
 * end state, and a value only animates when it *changes after mount* (or when the caller opts in to a first reveal),
 * so a streaming update never re-plays what the reader has already seen.
 */
import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { EASE, gsap } from "@/lib/motion/gsap";

const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** True once `value` has differed from what it was on the first render (a run event landed while we watched). */
export function useChangedAfterMount<T>(value: T): boolean {
  const [first] = useState(value);
  return value !== first;
}

/**
 * Cursor light: set `--mx` / `--my` (px, element-relative) on the nearest `[data-spot]` under the pointer. Bind it to a
 * container's onPointerMove so a whole grid of tiles shares one listener; CSS draws the light from the variables.
 */
export function spotlight(e: ReactPointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse") return;
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-spot]");
  if (!el || !e.currentTarget.contains(el)) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}

/** A soft magnetic pull toward the cursor for one primary button (fine pointers only, never with reduced motion). */
export function useMagnet<T extends HTMLElement>(ref: RefObject<T | null>, { strength = 0.22, radius = 90, disabled = false } = {}) {
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || disabled || !window.matchMedia("(pointer: fine)").matches) return;
    const x = gsap.quickTo(el, "x", { duration: 0.6, ease: EASE.out });
    const y = gsap.quickTo(el, "y", { duration: 0.6, ease: EASE.out });
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const reach = Math.max(r.width, r.height) / 2 + radius;
      if (Math.hypot(dx, dy) > reach) {
        x(0);
        y(0);
        return;
      }
      x(dx * strength);
      y(dy * strength * 0.8);
    };
    const reset = () => {
      x(0);
      y(0);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", reset);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", reset);
      gsap.set(el, { x: 0, y: 0 });
    };
  }, [ref, reduced, disabled, strength, radius]);
}

/**
 * A number that moves to its new value: counts (tweening the raw number through the caller's formatter, so metric
 * decimals and signs stay right) or scrambles its digits into place. `reveal` plays it once on mount (from `from`);
 * otherwise it only animates when the value changes after mount.
 */
export function Num({
  value,
  format,
  fallback = "—",
  mode = "count",
  reveal = false,
  from = 0,
  duration,
  delay = 0,
  animate = true,
  className,
}: {
  value: number | null | undefined;
  format: (v: number) => string;
  fallback?: string;
  mode?: "count" | "scramble";
  reveal?: boolean;
  from?: number;
  duration?: number;
  delay?: number;
  /** false: just show the value (e.g. a finished run's map header, which shouldn't count on load). */
  animate?: boolean;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const text = value == null || !Number.isFinite(value) ? fallback : format(value);
  const [initial] = useState(text);
  const st = useRef<{ text: string; v: number | null; mounted: boolean; pending: { from: number | null } | null }>({
    text,
    v: value ?? null,
    mounted: false,
    pending: null,
  });

  useIso(() => {
    const el = ref.current;
    if (!el) return;
    const s = st.current;
    const prevText = s.text;
    const prevV = s.v;
    const first = !s.mounted;
    s.mounted = true;
    s.text = text;
    s.v = value ?? null;
    let start: number | null = null;
    if (s.pending && prevText === text)
      start = s.pending.from; // a cancelled run of the same animation (dev double-mount)
    else if (first && reveal) start = from;
    else if (!first && prevText !== text) start = prevV;
    if (!animate || reduced || value == null || !Number.isFinite(value) || start == null) {
      s.pending = null;
      el.textContent = text;
      return;
    }
    s.pending = { from: start };
    const done = () => {
      s.pending = null;
      el.textContent = text;
    };
    let tw: gsap.core.Tween;
    if (mode === "scramble") {
      // Digits settle left to right; punctuation (".", ",", "−", "$") holds still, so the number keeps its shape.
      const o = { p: 0 };
      tw = gsap.to(o, {
        p: 1,
        duration: duration ?? 0.9,
        delay,
        ease: "power1.out",
        onUpdate: () => {
          const settled = Math.floor(o.p * text.length);
          let out = "";
          for (let i = 0; i < text.length; i++) {
            const c = text[i];
            out += i < settled || !/\d/.test(c) ? c : String((Math.random() * 10) | 0);
          }
          el.textContent = out;
        },
        onComplete: done,
      });
    } else {
      const o = { v: start };
      el.textContent = format(start);
      tw = gsap.to(o, {
        v: value,
        duration: duration ?? 1.1,
        delay,
        ease: EASE.out,
        onUpdate: () => {
          el.textContent = format(o.v);
        },
        onComplete: done,
      });
    }
    return () => {
      tw.kill();
    };
  }, [text]);

  return (
    <span className={className}>
      <span aria-hidden ref={ref} className="fx-num">
        {initial}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** Text that scrambles into place once on mount (a dataset's name arriving), then stays put. */
export function ScrambleIn({ text, chars = "lowerCase", duration = 0.9, className }: { text: string; chars?: string; duration?: number; className?: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  useIso(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    if (reduced) return;
    // Scrambling from the final text keeps the length (and so the line box) fixed from the first frame.
    const tw = gsap.to(el, {
      duration,
      ease: "none",
      scrambleText: { text, chars, speed: 0.55, tweenLength: false, revealDelay: 0.1 },
      onComplete: () => void (el.textContent = text),
    });
    return () => {
      tw.kill();
      el.textContent = text;
    };
  }, [text, reduced]);
  return (
    <span className={className}>
      <span aria-hidden ref={ref}>
        {text}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
