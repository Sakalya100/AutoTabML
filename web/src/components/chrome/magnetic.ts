"use client";

import { useEffect, type RefObject } from "react";
import { gsap, prefersReducedMotion } from "@/lib/motion/gsap";

/**
 * Leans an element toward a mouse pointer near it and settles back on leave (fine pointers only; off for reduced
 * motion). Transform-only, through gsap.quickTo, so it never re-renders React.
 */
export function useMagnetic(ref: RefObject<HTMLElement | null>, strength = 0.3) {
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || !window.matchMedia("(pointer: fine)").matches) return;
    const x = gsap.quickTo(el, "x", { duration: 0.8, ease: "expo.out" });
    const y = gsap.quickTo(el, "y", { duration: 0.8, ease: "expo.out" });
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = el.getBoundingClientRect();
      x((e.clientX - (r.left + r.width / 2)) * strength);
      y((e.clientY - (r.top + r.height / 2)) * strength * 1.3);
    };
    const leave = () => {
      x(0);
      y(0);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      gsap.set(el, { clearProps: "transform" });
    };
  }, [ref, strength]);
}
