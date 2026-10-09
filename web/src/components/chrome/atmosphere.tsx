"use client";

/**
 * Two quiet layers over the document pages, both fixed and pointer-transparent (the landing's press-and-hold reaches
 * the world through them), and neither ever wraps the page — a transform or filter on an ancestor would turn the
 * landing's fixed stage into an absolute one.
 *  - Grain: an SVG-noise tile at a whisper of opacity, stepped by transform (compositor only). Not in the workspace.
 *  - Route change: a void veil that lifts off the new page while a signal hairline draws across the top (≤ 450 ms).
 *    Never blocks the navigation (the page is already there underneath); skipped on first load, between two
 *    workspace pages (/s → /s/…), and for reduced motion.
 */
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { isAppRoute } from "./routes";

export function Atmosphere() {
  const pathname = usePathname() ?? "/";
  const app = isAppRoute(pathname);
  const prev = useRef<string | null>(null);
  const veil = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const from = prev.current;
    prev.current = pathname;
    if (from == null || from === pathname) return;
    if (isAppRoute(from) && isAppRoute(pathname)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ease = "cubic-bezier(0.16, 1, 0.3, 1)";
    const a = veil.current?.animate([{ opacity: 0.92 }, { opacity: 0 }], { duration: 440, easing: ease });
    const b = line.current?.animate(
      [
        { transform: "scaleX(0)", opacity: 1 },
        { transform: "scaleX(1)", opacity: 1, offset: 0.7 },
        { transform: "scaleX(1)", opacity: 0 },
      ],
      { duration: 640, easing: ease },
    );
    return () => {
      a?.cancel();
      b?.cancel();
    };
  }, [pathname]);

  return (
    <>
      {!app && <div className="site-grain" aria-hidden />}
      <div ref={veil} className="site-veil" aria-hidden />
      <div ref={line} className="site-route-line" aria-hidden />
    </>
  );
}
