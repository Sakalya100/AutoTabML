"use client";

/**
 * Lenis smooth scrolling for the document-scrolling pages (landing, replays, privacy), driven by GSAP's ticker so
 * ScrollTrigger and Lenis share one clock. Off for reduced motion and inside the workspace, which is an app with its
 * own scroll panes (they also carry data-lenis-prevent). Scroll position stays native (window.scrollY), so code
 * that reads it keeps working.
 */
import { ReactLenis, useLenis, type LenisRef } from "lenis/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { gsap, ScrollTrigger } from "@/lib/motion/gsap";
import "lenis/dist/lenis.css";

const APP_ROUTES = /^\/(s|sign-in|sign-up)(\/|$)/;

function useReducedMotion(): boolean {
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

/** Keep ScrollTrigger in step with Lenis, and start each page at the top. */
function Sync() {
  const pathname = usePathname();
  useLenis(() => ScrollTrigger.update());
  const lenis = useLenis();
  useEffect(() => {
    lenis?.scrollTo(0, { immediate: true });
    ScrollTrigger.refresh();
  }, [pathname, lenis]);
  return null;
}

export function SmoothScroll({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const reduced = useReducedMotion();
  const ref = useRef<LenisRef>(null);
  const enabled = !reduced && !APP_ROUTES.test(pathname);

  useEffect(() => {
    if (!enabled) return;
    const tick = (time: number) => ref.current?.lenis?.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => gsap.ticker.remove(tick);
  }, [enabled]);

  if (!enabled) return <>{children}</>;
  return (
    <ReactLenis root ref={ref} options={{ autoRaf: false, lerp: 0.085, wheelMultiplier: 0.95, anchors: true, allowNestedScroll: true }}>
      <Sync />
      {children}
    </ReactLenis>
  );
}
