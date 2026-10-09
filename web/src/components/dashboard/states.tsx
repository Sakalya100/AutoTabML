"use client";

/* The dashboard's other faces: loading (a skeleton the exact shape of the page), error, no runs yet, signed out. */
import { SignInButton } from "@clerk/nextjs";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRef } from "react";
import { AUTH_ENABLED } from "@/components/auth";
import { useMagnetic } from "@/components/chrome/magnetic";
import { RevealHeading } from "@/components/replay/motion";
import { useWebGLAvailable } from "@/lib/gl";
import { useReducedMotion } from "./motion";

const Topography = dynamic(() => import("@/components/bits/Topography"), { ssr: false });

/** Placeholder blocks in the real layout's boxes, so nothing moves when the numbers arrive. */
export function DashSkeleton() {
  return (
    <div className="dash-skel" aria-busy="true" aria-label="Loading your dashboard">
      <section className="dash-kpis">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="dash-tile dash-tile-skel">
            <span className="dash-shimmer" style={{ width: "42%", height: 10 }} />
            <span className="dash-shimmer" style={{ width: "58%", height: 30, marginTop: 18 }} />
            <span className="dash-shimmer" style={{ width: "76%", height: 10, marginTop: 14 }} />
            <span className="dash-shimmer" style={{ width: "100%", height: 30, marginTop: 16 }} />
          </div>
        ))}
      </section>
      <div className="dash-grid">
        <div className="dash-card dash-activity dash-card-skel">
          <span className="dash-shimmer" style={{ width: 120, height: 18 }} />
          <span className="dash-shimmer" style={{ width: 240, height: 10, marginTop: 12 }} />
          <span className="dash-shimmer" style={{ width: "100%", height: 260, marginTop: 22 }} />
        </div>
        <div className="dash-card dash-providers dash-card-skel">
          <span className="dash-shimmer" style={{ width: 130, height: 18 }} />
          {[0, 1, 2].map((i) => (
            <span key={i} className="dash-shimmer" style={{ width: "100%", height: 40, marginTop: 26 }} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function DashError({ onRetry, message }: { onRetry: () => void; message: string }) {
  return (
    <div className="dash-state" role="alert">
      <p className="dash-kicker">
        <span className="dash-kicker-dot" data-bad="" aria-hidden />
        Couldn’t load
      </p>
      <h2 className="dash-state-h">The numbers didn’t arrive.</h2>
      <p className="dash-state-p">{message}</p>
      <button type="button" className="lp-cta lp-cta-ghost dash-retry" onClick={onRetry}>
        Try again <span aria-hidden>↻</span>
      </button>
    </div>
  );
}

function CtaLink({ href, children }: { href: string; children: React.ReactNode }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useMagnetic(ref, 0.24);
  return (
    <Link
      ref={ref}
      href={href}
      className="lp-cta lp-cta-primary"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
        e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
      }}
    >
      <span className="relative z-10">{children}</span>
      <span aria-hidden className="lp-cta-arrow relative z-10">
        →
      </span>
    </Link>
  );
}

/** The contour field behind the invitation: one WebGL context, paused off-screen, none for reduced motion or no GL. */
function Contours() {
  const gl = useWebGLAvailable();
  const reduced = useReducedMotion();
  if (!gl || reduced) return <div className="dash-empty-still" aria-hidden />;
  return (
    <div className="dash-empty-field" aria-hidden>
      <Topography
        lowColor="#1a1d22"
        midColor="#6f6b63"
        highColor="#ece7dc"
        colorMode="elevation"
        speed={0.2}
        morphSpeed={0.04}
        morphAmount={2.4}
        bands={4.5}
        thickness={0.012}
        glow={0.35}
        contrast={2.6}
        brightness={0.9}
        scale={1.15}
        opacity={0.5}
        grain={false}
        mouseInteraction
        mouseRadius={0.22}
        mouseStrength={0.32}
      />
    </div>
  );
}

export function DashEmpty() {
  return (
    <section className="dash-empty" aria-labelledby="dash-empty-h">
      <Contours />
      <div className="dash-empty-copy">
        <p className="dash-kicker">
          <span className="dash-kicker-dot" aria-hidden />
          No runs yet
        </p>
        <RevealHeading as="h2" id="dash-empty-h" className="dash-empty-h" pre>
          Your map is <em>blank</em>. Let’s survey something.
        </RevealHeading>
        <p className="dash-state-p">
          Give AutoTinker a CSV and the column to predict. It tries ideas one at a time, keeps only the gains that are real, stops when there’s nothing left to
          find, and tells you how far to trust the result. Every run lands here.
        </p>
        <div className="dash-empty-ctas">
          <CtaLink href="/s/new">Try it on your data</CtaLink>
          <Link href="/replays" className="lp-cta lp-cta-ghost">
            Watch a replay first
          </Link>
        </div>
      </div>
    </section>
  );
}

export function DashSignedOut() {
  return (
    <section className="dash-state dash-signedout" aria-labelledby="dash-so-h">
      <p className="dash-kicker">
        <span className="dash-kicker-dot" aria-hidden />
        Sign in
      </p>
      <RevealHeading as="h1" id="dash-so-h" className="dash-state-h dash-state-h-lg" pre>
        Sign in to see your <em>dashboard</em>.
      </RevealHeading>
      <p className="dash-state-p">
        Your runs, what they found, what they cost and how far to trust them, in one place. Use Google, or a one-time code by email.
      </p>
      <div className="dash-empty-ctas">
        {AUTH_ENABLED ? (
          <SignInButton mode="modal" forceRedirectUrl="/dashboard" signUpForceRedirectUrl="/dashboard">
            <button type="button" className="lp-cta lp-cta-primary">
              <span className="relative z-10">Sign in</span>
              <span aria-hidden className="lp-cta-arrow relative z-10">
                →
              </span>
            </button>
          </SignInButton>
        ) : null}
        <Link href="/replays" className="lp-cta lp-cta-ghost">
          Or watch a replay
        </Link>
      </div>
    </section>
  );
}
