"use client";

/*
 * 404, in the site's cartography: the known map ends in a torn edge, the route runs off it into the void, and the
 * compass can't find north. Everything is drawn in hairlines (no WebGL): contours and the route draw themselves in,
 * the chart drifts a little toward the pointer, the needle keeps hunting. Static under reduced motion.
 */

import { useRef } from "react";
import { MagneticLink } from "@/components/landing/primitives";
import { RevealHeading, ScrambleNumber } from "@/components/replay/motion";
import { EASE, gsap, useGSAP } from "@/lib/motion/gsap";
import "@/components/terra.css";
import "./not-found.css";

/** One island's contour rings: a lumpy closed curve, shrunk ring by ring toward its summit. */
function contours(cx: number, cy: number, R: number, rings: number, seed: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < rings; k++) {
    const s = 1 - k * (0.86 / rings);
    const shift = k * 6;
    let d = "";
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2;
      const r = R * s * (1 + 0.13 * Math.sin(3 * t + seed + k * 0.22) + 0.07 * Math.sin(5 * t - seed * 1.7 + k * 0.31) + 0.035 * Math.sin(9 * t + seed * 2.3));
      const x = cx + shift + r * Math.cos(t) * 1.18;
      const y = cy - shift * 0.6 + r * Math.sin(t);
      d += `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }
    out.push(d + "Z");
  }
  return out;
}

const ISLAND_A = contours(250, 560, 230, 8, 0.7);
const ISLAND_B = contours(610, 210, 110, 5, 2.4);
/** The edge of the known map: a torn, wandering vertical line. */
const EDGE = (() => {
  let d = "M820,-20";
  for (let y = 0; y <= 820; y += 20) d += `L${(820 + 9 * Math.sin(y * 0.05) + 5 * Math.sin(y * 0.17 + 1)).toFixed(1)},${y}`;
  return d;
})();
/** The route: from the island's summit, east, and off the edge. */
const ROUTE = "M300,520 C380,470 450,470 520,430 S650,330 740,360 S860,450 930,410 S1010,330 1050,345";

export default function NotFound() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const tl = gsap.timeline({ defaults: { ease: EASE.out } });
        tl.from(".nf-ring", { strokeDashoffset: 1, duration: 2.6, stagger: 0.07 }, 0.1)
          .from(".nf-grat", { opacity: 0, duration: 2 }, 0)
          .from(".nf-edge", { strokeDashoffset: 1, duration: 2.2, ease: "power2.inOut" }, 0.3)
          .from(".nf-route", { strokeDashoffset: 1, duration: 2.8, ease: "power2.inOut" }, 0.9)
          .from(".nf-mark, .nf-dragons", { opacity: 0, y: 8, duration: 1.4, stagger: 0.25 }, 2.6)
          .from(".nf-seq", { opacity: 0, y: 18, duration: 1.1, stagger: 0.09 }, 0.55)
          .from(".nf-compass", { opacity: 0, scale: 0.9, duration: 1.6 }, 0.4);

        // the needle hunts for a north that isn't there: slow swings, never settling
        gsap.to(".nf-needle", {
          rotation: () => gsap.utils.random(-70, 70),
          duration: () => gsap.utils.random(1.6, 3.2),
          ease: "sine.inOut",
          repeat: -1,
          repeatRefresh: true,
          transformOrigin: "50% 50%",
        });

        // the chart leans a little toward the pointer: near layers more than far ones
        const near = gsap.quickTo(".nf-near", "x", { duration: 1.4, ease: "power3.out" });
        const nearY = gsap.quickTo(".nf-near", "y", { duration: 1.4, ease: "power3.out" });
        const far = gsap.quickTo(".nf-far", "x", { duration: 1.8, ease: "power3.out" });
        const farY = gsap.quickTo(".nf-far", "y", { duration: 1.8, ease: "power3.out" });
        const onMove = (e: PointerEvent) => {
          if (e.pointerType !== "mouse") return;
          const x = e.clientX / window.innerWidth - 0.5;
          const y = e.clientY / window.innerHeight - 0.5;
          near(x * -22);
          nearY(y * -14);
          far(x * -8);
          farY(y * -5);
        };
        window.addEventListener("pointermove", onMove);
        return () => window.removeEventListener("pointermove", onMove);
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <main ref={root} data-terra className="nf-root">
      <svg className="nf-chart" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <defs>
          <linearGradient id="nf-fade" gradientUnits="userSpaceOnUse" x1={760} y1={0} x2={1050} y2={0}>
            <stop offset="0" className="nf-fade-a" />
            <stop offset="1" className="nf-fade-b" />
          </linearGradient>
        </defs>
        <g className="nf-far">
          {Array.from({ length: 13 }, (_, i) => (
            <line key={`v${i}`} className="nf-grat" x1={i * 100} x2={i * 100} y1={0} y2={800} />
          ))}
          {Array.from({ length: 9 }, (_, i) => (
            <line key={`h${i}`} className="nf-grat" x1={0} x2={1200} y1={i * 100} y2={i * 100} />
          ))}
          {[40, 41, 42].map((lat, i) => (
            <text key={lat} className="nf-grat nf-tick" x={8} y={700 - i * 300 + 14}>
              {lat}°N
            </text>
          ))}
        </g>
        <g className="nf-near">
          {ISLAND_A.map((d, i) => (
            <path key={`a${i}`} className="nf-ring" d={d} pathLength={1} style={{ opacity: 0.55 - i * 0.05 }} />
          ))}
          {ISLAND_B.map((d, i) => (
            <path key={`b${i}`} className="nf-ring" d={d} pathLength={1} style={{ opacity: 0.4 - i * 0.06 }} />
          ))}
          <path className="nf-edge" d={EDGE} pathLength={1} />
          <path className="nf-route" d={ROUTE} pathLength={1} />
          <g className="nf-mark" transform="translate(1050 345)">
            <circle r={4} className="nf-mark-dot" />
            <circle r={13} className="nf-mark-ring" />
            <text x={-12} y={-22} className="nf-label">
              you, probably
            </text>
          </g>
          <g className="nf-dragons" transform="translate(965 585)">
            {/* a sea serpent in three humps, the old way of saying "nobody has charted this" */}
            <path d="M-70,10 q12,-26 24,0 q12,-26 24,0 q12,-26 24,0 q8,-20 18,-12 q6,6 -2,10" className="nf-serpent" />
            <path d="M-86,16 h150" className="nf-water" />
            <text x={-90} y={44} className="nf-label nf-label-serif">
              here be dragons
            </text>
          </g>
        </g>
      </svg>
      <div className="nf-veil" aria-hidden />

      <div className="nf-compass" aria-hidden>
        <svg viewBox="-40 -40 80 80">
          <circle r={34} className="nf-c-ring" />
          {Array.from({ length: 24 }, (_, i) => (
            <line key={i} className="nf-c-tick" y1={-34} y2={i % 6 === 0 ? -27 : -31} transform={`rotate(${i * 15})`} />
          ))}
          <text y={-17} className="nf-c-n">
            N
          </text>
          <g className="nf-needle">
            <path d="M0,-22 L4,0 L0,3 L-4,0 Z" className="nf-n-head" />
            <path d="M0,22 L4,0 L0,-3 L-4,0 Z" className="nf-n-tail" />
          </g>
          <circle r={1.6} className="nf-c-pin" />
        </svg>
        <span className="nf-c-k">no fix</span>
      </div>

      <div className="nf-copy">
        <p className="nf-kicker nf-seq">Error 404 · off the chart</p>
        <RevealHeading as="h1" className="nf-h1" pre delay={0.2}>
          You’ve sailed off the edge of the <em>map.</em>
        </RevealHeading>
        <p className="nf-sub nf-seq">
          No chart we keep has this page on it. Old cartographers wrote <em>here be dragons</em> in places like this; we’d rather point you back to charted
          water.
        </p>
        <p className="nf-fix nf-seq">
          <span className="nf-fix-k">Last known position</span>
          <ScrambleNumber className="nf-fix-v" value="40.4040° N · 404.0404° W" duration={1.6} delay={0.9} />
          <span className="nf-fix-note">A longitude that doesn’t exist, which explains a lot.</span>
        </p>
        <div className="lp-ctas nf-ctas nf-seq">
          <MagneticLink href="/">Back to charted waters</MagneticLink>
          <MagneticLink href="/replays" variant="ghost">
            Browse the replays
          </MagneticLink>
        </div>
      </div>
    </main>
  );
}
