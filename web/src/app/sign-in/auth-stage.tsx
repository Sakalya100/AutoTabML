"use client";

/*
 * The sign-in and sign-up stage: the Clerk card, centred on a slow contour field (React Bits Topography — one WebGL
 * context, paused off-screen by the component itself) that swells a little under the pointer, at very low contrast
 * so it reads as paper texture, not decoration. One serif line above the card. Under reduced motion, or without
 * WebGL, the field is a still hairline drawing instead.
 */

import { useSyncExternalStore, type ReactNode } from "react";
import Topography from "@/components/bits/Topography";
import { RevealHeading } from "@/components/replay/motion";
import { useWebGLAvailable } from "@/lib/gl";
import "@/components/terra.css";
import "./auth-stage.css";

const reducedQ = {
  sub: (cb: () => void) => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    m.addEventListener("change", cb);
    return () => m.removeEventListener("change", cb);
  },
  get: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
};

/** Clerk's card in the stage's hairline language (classes in ./auth-stage.css). */
export const authCardAppearance = {
  elements: {
    cardBox: "au-cardbox",
    card: "au-card",
    footer: "au-footer",
    socialButtonsBlockButton: "au-social",
    dividerLine: "au-divider",
  },
};

export function AuthStage({ line, children }: { line: ReactNode; children: ReactNode }) {
  const reduced = useSyncExternalStore(reducedQ.sub, reducedQ.get, () => true);
  const webgl = useWebGLAvailable();
  const live = !reduced && webgl === true;
  return (
    <div data-terra className="au-root">
      <div className="au-field" aria-hidden>
        {live ? (
          <Topography
            lowColor="#05070a"
            midColor="#2b3542"
            highColor="#d9d3c4"
            speed={0.14}
            morphAmount={2.4}
            morphSpeed={0.025}
            bands={2.4}
            thickness={0.012}
            scale={1.15}
            glow={0.12}
            contrast={1.6}
            brightness={0.9}
            opacity={0.45}
            grain={false}
            mouseRadius={0.22}
            mouseStrength={0.32}
          />
        ) : (
          <StillField />
        )}
      </div>
      <div className="au-veil" aria-hidden />
      <div className="au-col">
        <p className="au-kicker">AutoTinker</p>
        <RevealHeading as="h1" className="au-line" pre delay={0.15}>
          {line}
        </RevealHeading>
        <div className="au-slot">{children}</div>
      </div>
    </div>
  );
}

/** The same idea, still: a few hairline rings, for reduced motion and for browsers without WebGL. */
function StillField() {
  return (
    <svg className="au-still" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">
      {Array.from({ length: 9 }, (_, k) => {
        const r = 120 + k * 70;
        return <ellipse key={k} cx={600 + k * 6} cy={430 - k * 4} rx={r * 1.25} ry={r * 0.82} />;
      })}
    </svg>
  );
}
