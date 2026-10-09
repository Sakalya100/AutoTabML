"use client";

/**
 * The hero: what the product is, in five seconds, said over the world.
 * Its entrance plays once, when the loader lifts (`play`): a mono kicker scrambles in, the headline rises line by line
 * through masks (GSAP SplitText), the rest settles after it, and the proof row counts up to the story run's real
 * numbers. Coming back to the hero later is an ordinary rail swap (no replay). Reduced motion: everything is simply
 * there.
 */
import { useRef, type CSSProperties } from "react";
import { formatScore, metricInfo } from "@/lib/metrics";
import { gsap, prefersReducedMotion, SplitText, useGSAP } from "@/lib/motion/gsap";
import type { LandingFacts } from "./facts";
import { MagneticLink } from "./primitives";

const KICKER = "AutoML for tables · knows when to stop";

export function Hero({ facts, replayHref, webgl, intro, play }: { facts: LandingFacts; replayHref: string; webgl: boolean; intro: boolean; play: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const label = metricInfo(facts.metric).label;
  const test = facts.final?.test ?? null;

  useGSAP(
    () => {
      const el = root.current;
      if (!el || !intro || !play) return;
      if (prefersReducedMotion()) {
        el.dataset.played = "";
        return;
      }
      let split: SplitText | null = null;
      let tl: gsap.core.Timeline | null = null;
      let alive = true;
      const h1 = el.querySelector<HTMLElement>(".lp-h1")!;
      const kicker = el.querySelector<HTMLElement>(".lp-kicker-text")!;
      const counts = Array.from(el.querySelectorAll<HTMLElement>("[data-count]"));
      // Split only once the display face is in, or the lines are measured in the fallback font and reflow.
      document.fonts.ready.then(() => {
        if (!alive) return;
        split = SplitText.create(h1, { type: "lines", mask: "lines", linesClass: "lp-line" });
        el.dataset.played = "";
        kicker.textContent = "";
        // Starts as the loader's curtain is halfway up, so the lines rise into the light rather than behind it.
        tl = gsap.timeline({ delay: 0.7, defaults: { ease: "expo.out" } });
        tl.to(kicker, { duration: 1.3, ease: "none", scrambleText: { text: KICKER, chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", speed: 0.5 } }, 0)
          .from(split.lines, { yPercent: 115, rotate: 1.5, duration: 1.25, stagger: 0.1 }, 0.12)
          .from(el.querySelectorAll(".lp-hero-after"), { y: 18, opacity: 0, duration: 1.1, stagger: 0.09 }, 0.55);
        counts.forEach((c, i) => {
          const to = Number(c.dataset.count);
          const digits = Number(c.dataset.digits ?? 0);
          const fmt = c.dataset.metric ? (n: number) => formatScore(c.dataset.metric, n) : (n: number) => n.toFixed(digits);
          const o = { v: 0 };
          c.textContent = fmt(0);
          tl!.to(o, { v: to, duration: 1.8, ease: "expo.out", onUpdate: () => void (c.textContent = fmt(o.v)) }, 0.8 + i * 0.12);
        });
      });
      return () => {
        alive = false;
        tl?.kill();
        split?.revert();
        kicker.textContent = KICKER;
        counts.forEach((c) => {
          const v = Number(c.dataset.count);
          c.textContent = c.dataset.metric ? formatScore(c.dataset.metric, v) : String(v);
        });
      };
    },
    { scope: root, dependencies: [intro, play] },
  );

  return (
    <div ref={root} className="lp-hero" data-intro={intro ? "" : undefined}>
      <p className="lp-kicker">
        <span className="lp-kicker-dot" aria-hidden />
        <span className="lp-kicker-text">{KICKER}</span>
      </p>
      <h1 className="lp-h1">
        Paste a CSV link.
        <br /> Get an honest <em>model.</em>
      </h1>
      <p className="lp-sub lp-hero-after">AI agents build and test a prediction model for your table, then tell you how good it really is.</p>
      <div className="lp-ctas lp-hero-after">
        <MagneticLink href="/s/new" requireAuth>
          Try it on your data
        </MagneticLink>
        <MagneticLink href={replayHref} variant="ghost">
          Watch a run
        </MagneticLink>
      </div>
      <dl className="lp-proof lp-hero-after" aria-label="Figures from the real run shown below">
        <div>
          <dt>experiments tried</dt>
          <dd data-count={facts.nExperiments} style={{ "--w": `${String(facts.nExperiments).length}ch` } as CSSProperties}>
            {facts.nExperiments}
          </dd>
        </div>
        <div>
          <dt>kept</dt>
          <dd className="lp-signal" data-count={facts.nKept}>
            {facts.nKept}
          </dd>
        </div>
        {test != null && (
          <div>
            <dt>{label} on unseen data</dt>
            <dd data-count={test} data-metric={facts.metric}>
              {formatScore(facts.metric, test)}
            </dd>
          </div>
        )}
      </dl>
      <p className="lp-hint lp-hero-after">
        <span className="lp-hint-line" aria-hidden />
        <span>
          Scroll to watch that run
          {webgl && <span className="lp-hint-alt"> · press and hold to light up the map</span>}
        </span>
      </p>
    </div>
  );
}
