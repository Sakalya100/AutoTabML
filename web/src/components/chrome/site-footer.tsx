"use client";

/**
 * The site's close: a quiet line, the links, and the wordmark set huge in the display serif, rising letter by letter
 * through a mask as it scrolls into view. Stays a direct child of <body> (page CSS targets `body > footer`).
 * In the workspace (a fixed-height app) it is a single compact row.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { DOCS_URL, GITHUB_URL } from "@/lib/links";
import { gsap, prefersReducedMotion, ScrollTrigger, SplitText, useGSAP } from "@/lib/motion/gsap";
import { isAppRoute } from "./routes";

export function SiteFooter() {
  const pathname = usePathname();
  const app = isAppRoute(pathname);
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mark = root.current?.querySelector<HTMLElement>(".site-foot-mark");
      const rule = root.current?.querySelector<HTMLElement>(".site-foot-rule");
      if (!mark || !rule || prefersReducedMotion()) return;
      const split = SplitText.create(mark, { type: "chars", mask: "chars" });
      const tl = gsap.timeline({ paused: true });
      tl.fromTo(rule, { scaleX: 0 }, { scaleX: 1, duration: 1.4, ease: "expo.inOut" }, 0).from(
        split.chars,
        { yPercent: 105, duration: 1.3, ease: "expo.out", stagger: 0.045 },
        0.15,
      );
      const st = ScrollTrigger.create({ trigger: mark, start: "top 96%", once: true, onEnter: () => tl.play() });
      return () => {
        st.kill();
        tl.kill();
        split.revert();
      };
    },
    { scope: root, dependencies: [app, pathname], revertOnUpdate: true },
  );

  if (app)
    return (
      <footer className="site-foot" data-app="">
        <div className="site-foot-compact">
          <span>AutoTinker v2 · MIT</span>
          <a href={GITHUB_URL} className="site-u">
            Source
          </a>
          <a href={DOCS_URL} className="site-u">
            Roadmap &amp; design notes
          </a>
          <Link href="/privacy" className="site-u">
            Privacy
          </Link>
        </div>
      </footer>
    );

  return (
    <footer ref={root} className="site-foot">
      <div className="site-foot-inner">
        <div className="site-foot-top">
          <p className="site-foot-line">
            A tabular ML agent that keeps only real gains, stops at the ceiling, and tells you <em>how much it overfit.</em>
          </p>
          <nav className="site-foot-nav" aria-label="Footer">
            <Link href="/replays" className="site-u">
              Replays
            </Link>
            <a href={GITHUB_URL} className="site-u">
              GitHub
            </a>
            <a href={DOCS_URL} className="site-u">
              Roadmap &amp; design notes
            </a>
            <Link href="/privacy" className="site-u">
              Privacy
            </Link>
          </nav>
        </div>
        <span className="site-foot-rule" aria-hidden />
        <p className="site-foot-mark" aria-hidden>
          Auto<em>Tinker</em>
        </p>
        <p className="site-foot-base">
          <span>v2 · MIT licensed</span>
          <span>Tabular ML that knows when to stop.</span>
        </p>
      </div>
    </footer>
  );
}
