"use client";

/*
 * The dashboard's small motion pieces, all transform / opacity / text only and all still under reduced motion:
 *   - TweenNumber: a number that counts up on first view and re-tweens from its last value when it changes;
 *   - Segmented: a row of choices with an amber indicator that slides to the chosen one;
 *   - useSpotlight: a soft light that follows the pointer across an element (CSS vars, no re-render).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { EASE, gsap, prefersReducedMotion } from "@/lib/motion/gsap";

const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Counts from 0 (first time) or from the last shown value to `value`, writing text directly. Tabular mono: no shift. */
export function TweenNumber({
  value,
  format,
  delay = 0,
  duration = 1.4,
  className,
}: {
  value: number;
  format: (n: number) => string;
  delay?: number;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const fmt = useRef(format);
  useIso(() => {
    fmt.current = format;
  });

  useIso(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current ?? 0;
    if (prefersReducedMotion() || from === value) {
      shown.current = value;
      el.textContent = fmt.current(value);
      return;
    }
    const o = { v: from };
    el.textContent = fmt.current(from);
    const tw = gsap.to(o, {
      v: value,
      duration: shown.current == null ? duration : duration * 0.7,
      delay: shown.current == null ? delay : 0,
      ease: "expo.out",
      onUpdate: () => {
        shown.current = o.v;
        el.textContent = fmt.current(o.v);
      },
      onComplete: () => {
        shown.current = value;
        el.textContent = fmt.current(value);
      },
    });
    return () => {
      tw.kill();
    };
  }, [value]);

  return (
    <span ref={ref} className={className} suppressHydrationWarning>
      {format(value)}
    </span>
  );
}

/** A pointer-following light: sets --mx / --my on the element (styled in dashboard.css). */
export function useSpotlight(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !window.matchMedia("(pointer: fine)").matches) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    el.addEventListener("pointermove", move);
    return () => el.removeEventListener("pointermove", move);
  }, [ref]);
}

/** Choices in a pill, the chosen one under a sliding amber indicator. Arrow keys move between them. */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  size = "md",
}: {
  label: string;
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  const root = useRef<HTMLDivElement>(null);
  const ind = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  useIso(() => {
    const r = root.current;
    const i = ind.current;
    if (!r || !i) return;
    const place = (animate: boolean) => {
      const btn = r.querySelector<HTMLElement>(`[data-v="${String(value)}"]`);
      if (!btn) return;
      const to = { x: btn.offsetLeft, width: btn.offsetWidth };
      if (!animate || prefersReducedMotion()) gsap.set(i, to);
      else gsap.to(i, { ...to, duration: 0.6, ease: EASE.out, overwrite: true });
    };
    place(placed.current);
    placed.current = true;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(r);
    return () => ro.disconnect();
  }, [value]);

  const idx = options.findIndex((o) => o.value === value);
  return (
    <div ref={root} className="dash-seg" data-size={size} role="radiogroup" aria-label={label}>
      <span ref={ind} className="dash-seg-ind" aria-hidden />
      {options.map((o, k) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={k === idx ? 0 : -1}
          data-v={String(o.value)}
          data-on={o.value === value ? "" : undefined}
          className="dash-seg-btn"
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const n = options[(idx + d + options.length) % options.length];
            onChange(n.value);
            requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-v="${String(n.value)}"]`)?.focus());
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
