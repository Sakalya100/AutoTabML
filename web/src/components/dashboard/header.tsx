"use client";

import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { AUTH_ENABLED } from "@/components/auth";
import { useMagnetic } from "@/components/chrome/magnetic";
import { useLineReveal } from "@/components/replay/motion";
import { greeting, RANGES, type RangeDays } from "@/lib/dashboard";
import { gsap, prefersReducedMotion } from "@/lib/motion/gsap";
import { Segmented } from "./motion";

interface FirstName {
  /** Clerk has settled (always true when auth is off), so the greeting won't change under the line reveal. */
  loaded: boolean;
  name: string | null;
}
/** The signed-in person's first name (null when auth is off or Clerk has none). Chosen once per build. */
const useClerkFirstName = (): FirstName => {
  const { isLoaded, user } = useUser();
  return { loaded: isLoaded, name: user?.firstName || user?.username || null };
};
const noName: FirstName = { loaded: true, name: null };
const useNoName = (): FirstName => noName;
export const useFirstName: () => FirstName = AUTH_ENABLED ? useClerkFirstName : useNoName;

/** "Good evening" by the viewer's own clock; null on the server, so the server and client never disagree. */
const noop = () => () => {};
const useGreeting = () =>
  useSyncExternalStore(
    noop,
    () => greeting(new Date().getHours()),
    () => null,
  );

/** "12 runs · 148 experiments · last run 2h ago", scrambling into place whenever it changes. */
function ScrambleLine({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      el.textContent = text;
      return;
    }
    const tw = gsap.to(el, {
      duration: 1.1,
      delay: el.dataset.done ? 0 : 0.55,
      ease: "none",
      scrambleText: { text, chars: "0123456789·/—", speed: 0.6, revealDelay: 0.25 },
    });
    el.dataset.done = "1";
    return () => {
      tw.kill();
    };
  }, [text]);
  return (
    <p className="dash-sub" aria-live="polite">
      <span ref={ref} aria-hidden>
        {" "}
      </span>
      <span className="sr-only">{text}</span>
    </p>
  );
}

function NewRunButton() {
  const ref = useRef<HTMLAnchorElement>(null);
  useMagnetic(ref, 0.24);
  return (
    <Link
      ref={ref}
      href="/s/new"
      className="lp-cta lp-cta-primary dash-cta"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
        e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
      }}
    >
      <span className="relative z-10">New run</span>
      <span aria-hidden className="lp-cta-arrow relative z-10">
        →
      </span>
    </Link>
  );
}

export function DashHeader({ line, days, onDays }: { line: string | null; days: RangeDays; onDays: (d: RangeDays) => void }) {
  const { loaded, name } = useFirstName();
  const hello = useGreeting();
  const ready = loaded && hello != null;
  const title = useRef<HTMLHeadingElement>(null);
  // The heading mounts once its words are final, so SplitText never has React re-render text it has split.
  useLineReveal(title, { delay: 0.05, stagger: 0.09, key: ready ? `${hello}|${name}` : null });
  return (
    <header className="dash-head">
      <div className="dash-head-copy">
        <p className="dash-kicker">
          <span className="dash-kicker-dot" aria-hidden />
          Your dashboard
        </p>
        {ready ? (
          <h1 key={`${hello}|${name}`} ref={title} className="dash-h1" data-pre="">
            {hello}
            {name ? (
              <>
                , <em>{name}</em>.
              </>
            ) : (
              "."
            )}
          </h1>
        ) : (
          <h1 className="dash-h1" aria-hidden style={{ visibility: "hidden" }}>
            Good evening.
          </h1>
        )}
        {line ? <ScrambleLine text={line} /> : <p className="dash-sub dash-sub-skel" aria-hidden />}
      </div>
      <div className="dash-head-actions">
        <Segmented
          label="Time range"
          value={days}
          onChange={onDays}
          options={RANGES.map((d) => ({
            value: d,
            label: (
              <>
                {d}
                <span className="dash-seg-long"> days</span>
                <span className="dash-seg-short" aria-hidden>
                  d
                </span>
              </>
            ),
          }))}
        />
        <NewRunButton />
      </div>
    </header>
  );
}
