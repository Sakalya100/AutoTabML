"use client";

/**
 * GSAP, registered once for the whole app (GSAP 3.15: every plugin is free). Import gsap and plugins from here so
 * registration happens before any component uses them.
 */
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

if (typeof window !== "undefined") gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, ScrambleTextPlugin);

/** The house motion language: long, soft settles. Pair `out` with 0.7–1.2 s, `inOut` for camera-like moves. */
export const EASE = { out: "expo.out", soft: "power3.out", inOut: "power2.inOut", spring: "back.out(1.4)" } as const;
export const DUR = { quick: 0.35, base: 0.7, slow: 1.1, reveal: 1.25 } as const;
/** The same curve for CSS / motion (cubic-bezier of expo.out ≈ [0.16, 1, 0.3, 1]). */
export const EASE_CSS = [0.16, 1, 0.3, 1] as const;

export const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export { gsap, ScrambleTextPlugin, ScrollTrigger, SplitText, useGSAP };
