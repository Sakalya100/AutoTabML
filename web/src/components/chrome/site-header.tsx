"use client";

/**
 * The site header. It stays a direct child of <body> and exactly 57px tall: the workspace grid
 * (--ws-head) and the landing / replay hero spacers (calc(100svh - 57px)) are measured against it.
 * On document pages it is sticky: clear at the top, a frosted hairline bar once scrolled, tucked away while reading
 * down and back on any scroll up (or when it takes keyboard focus). In the workspace it is a plain fixed row.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { AuthControls } from "@/components/auth";
import { GITHUB_URL } from "@/lib/links";
import { isAppRoute } from "./routes";

export function SiteHeader() {
  const pathname = usePathname();
  const app = isAppRoute(pathname);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.removeAttribute("data-hidden");
    if (app) {
      el.removeAttribute("data-scrolled");
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let lastY = window.scrollY;
    let hidden = false;
    let raf = 0;
    const setHidden = (h: boolean) => {
      if (h === hidden) return;
      hidden = h;
      el.toggleAttribute("data-hidden", h);
    };
    const update = () => {
      raf = 0;
      const y = Math.max(0, window.scrollY);
      el.toggleAttribute("data-scrolled", y > 12);
      const dy = y - lastY;
      if (Math.abs(dy) < 6) return;
      lastY = y;
      if (y < 140 || dy < 0) setHidden(false);
      else if (!reduced && !el.contains(document.activeElement)) setHidden(true);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onFocus = () => setHidden(false);
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("focusin", onFocus);
    return () => {
      window.removeEventListener("scroll", onScroll);
      el.removeEventListener("focusin", onFocus);
      cancelAnimationFrame(raf);
    };
  }, [app, pathname]);

  return (
    <header ref={ref} className="site-head" data-app={app ? "" : undefined}>
      <div className="site-head-row">
        <Link href="/" className="site-logo" aria-label="AutoTinker home">
          Auto<span className="site-logo-tinker">Tinker</span>
        </Link>
        <nav className="site-nav" aria-label="Site">
          <Link href="/replays" className="site-nav-link" aria-current={pathname?.startsWith("/replays") ? "page" : undefined}>
            Replays
          </Link>
          <a href={GITHUB_URL} className="site-nav-link" data-wide="">
            GitHub
          </a>
          <AuthControls />
        </nav>
      </div>
    </header>
  );
}
