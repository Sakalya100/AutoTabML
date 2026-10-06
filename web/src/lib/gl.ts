"use client";

/* WebGL / motion / visibility probes shared by the survey panel and the gallery. */

import { useSyncExternalStore } from "react";

let cached: boolean | null = null;

/** True if this browser can create a WebGL context (cached after the first probe). */
export function isWebGLAvailable(): boolean {
  if (cached != null) return cached;
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    cached = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}

const noop = () => () => {};

/** null during SSR / hydration, then whether WebGL works — so callers can show a skeleton instead of flashing. */
export function useWebGLAvailable(): boolean | null {
  return useSyncExternalStore(noop, isWebGLAvailable, () => null);
}

function subscribeMotion(cb: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

function subscribeVisibility(cb: () => void) {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}
