"use client";

import Link from "next/link";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

export const EASE = [0.22, 1, 0.36, 1] as const;

/** Fade-up reveal the first time it scrolls into view. */
export function Reveal({ children, delay = 0, className, y = 22 }: { children: ReactNode; delay?: number; className?: string; y?: number }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.9, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** Headline that surfaces word by word, like something rising through water. The observer sits on the
 * un-clipped wrapper (a translated child inside overflow:hidden never "intersects"). */
export function RiseWords({ text, className, delay = 0, stagger = 0.06 }: { text: string; className?: string; delay?: number; stagger?: number }) {
  const words = text.split(" ");
  return (
    <motion.span
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.5 }}
      variants={{ hidden: {}, show: { transition: { delayChildren: delay, staggerChildren: stagger } } }}
    >
      {words.map((w, i) => (
        <span key={i} className="inline-block overflow-hidden pb-[0.12em] align-bottom">
          <motion.span
            className="inline-block"
            variants={{ hidden: { y: "105%", opacity: 0 }, show: { y: "0%", opacity: 1, transition: { duration: 1, ease: EASE } } }}
          >
            {w}
          </motion.span>
          {i < words.length - 1 ? "\u00a0" : null}
        </span>
      ))}
    </motion.span>
  );
}

/** A number that glides to its new value (real values only — the caller passes them in). */
export function Ticker({ value, format, className }: { value: number | null; format: (n: number) => string; className?: string }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(value ?? 0);
  const spring = useSpring(mv, { stiffness: 140, damping: 24, mass: 0.6 });
  const text = useTransform(spring, (n: number) => format(n));
  useEffect(() => {
    if (value == null) return;
    if (reduce) spring.jump(value);
    else mv.set(value);
  }, [value, mv, spring, reduce]);
  if (value == null) return <span className={className}>—</span>;
  return <motion.span className={className}>{text as MotionValue<string>}</motion.span>;
}

/** CTA that leans toward the cursor. */
export function MagneticLink({ href, children, variant = "primary", external = false }: { href: string; children: ReactNode; variant?: "primary" | "ghost"; external?: boolean }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const reduce = useReducedMotion();
  const x = useSpring(0, { stiffness: 220, damping: 16, mass: 0.4 });
  const y = useSpring(0, { stiffness: 220, damping: 16, mass: 0.4 });
  const onMove = (e: React.PointerEvent) => {
    if (reduce || e.pointerType !== "mouse" || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    x.set((e.clientX - (r.left + r.width / 2)) * 0.28);
    y.set((e.clientY - (r.top + r.height / 2)) * 0.38);
  };
  const reset = () => {
    x.set(0);
    y.set(0);
  };
  const cls = variant === "primary" ? "lp-cta lp-cta-primary" : "lp-cta lp-cta-ghost";
  const inner = (
    <>
      <span className="relative z-10">{children}</span>
      <span aria-hidden className="lp-cta-arrow relative z-10">
        →
      </span>
    </>
  );
  const MotionLink = external ? motion.a : MotionNextLink;
  return (
    <MotionLink ref={ref} href={href} className={cls} style={{ x, y }} onPointerMove={onMove} onPointerLeave={reset}>
      {inner}
    </MotionLink>
  );
}

const MotionNextLink = motion.create(Link);
