"use client";

/**
 * Terra Incognita — the survey world for one run. Load with next/dynamic({ ssr: false }). Renders nothing when
 * WebGL is unavailable (the caller shows its own fallback). See docs/creative/02-direction.md and lib/survey/contract.ts.
 */
import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Vector3 } from "three";
import { fmtNum, formatScore, metricInfo } from "@/lib/metrics";
import type { RunView } from "@/lib/run-state";
import { usePageVisible, usePrefersReducedMotion, useWebGLAvailable } from "@/lib/gl";
import { SURVEY, type SurveyCanvasProps } from "@/lib/survey/contract";
import { layoutSurvey } from "@/lib/survey/layout";
import type { TruthLabels } from "./atmosphere";
import { Post } from "./post";
import { createSonarInput } from "./shared";
import type { ProbeLabel } from "./type";
import { SurveyWorld } from "./world";

function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView] as const;
}

const CATEGORY: Record<string, string> = {
  baseline: "baseline",
  preprocessing: "preprocessing",
  feature_engineering: "feature engineering",
  model_family: "model family",
  hyperparameters: "hyperparameters",
  ensembling: "ensembling",
  simplification: "simplification",
  repair: "repair",
};

function probeLabels(v: RunView): Map<string, ProbeLabel> {
  const out = new Map<string, ProbeLabel>();
  for (const x of v.experiments) {
    const score = x.cv ? formatScore(v.metric, x.cv.mean) : x.status === "crash" ? "crashed" : "…";
    const cat = CATEGORY[x.idea?.category ?? ""] ?? x.idea?.category ?? "";
    out.set(x.id, { id: x.id, line1: `${x.id}  ${score}`, line2: `${cat}${x.idea?.radical ? " · radical" : ""} · ${x.status}`.toUpperCase() });
  }
  return out;
}

function truthLabels(v: RunView): TruthLabels | null {
  const f = v.final;
  if (!f) return null;
  const d = metricInfo(v.metric).digits;
  return {
    cv: `CV ${formatScore(v.metric, f.devCvMean)}`,
    select: `SELECT ${formatScore(v.metric, f.selectScore)}`,
    test: `LOCKED TEST ${formatScore(v.metric, f.testScore)}`,
    gap: `GAP ${fmtNum(Math.abs(f.optimismGap), d)} · ${f.optimismGap > 0 ? "OPTIMISTIC" : f.optimismGap < 0 ? "NO OPTIMISM" : "NONE"}`,
  };
}

// Stable prop identities: the canvas re-renders at scroll rate, and fresh dpr/camera objects would make R3F
// re-apply them (a dpr change resizes the renderer and every composer target).
const GL = { antialias: false, powerPreference: "high-performance", alpha: false, stencil: false, depth: true } as const;
const CAMERA = { fov: 34, near: 0.1, far: 420, position: [30, 30, 30] as [number, number, number] };
const DPR_FULL: [number, number] = [1, 1.75];
const DPR_LITE: [number, number] = [1, 1.25];
const DPR_MIN: [number, number] = [1, 1];

/** Poster tier: render a few frames, then stop the loop. */
function PosterStop() {
  const setFrameloop = useThree((s) => s.setFrameloop);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let n = 0;
    let raf = 0;
    const tick = () => {
      if (++n > 24) return setFrameloop("never");
      invalidate();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setFrameloop, invalidate]);
  return null;
}

export default function SurveyCanvas({
  view,
  domainView = null,
  pose = "overview",
  poseProgress = 0,
  selectedId = null,
  onSelect,
  quality = "full",
  interactive = false,
  headline = null,
  className,
  ariaLabel,
  onReady,
  scrub,
  ghost = false,
}: SurveyCanvasProps) {
  const webgl = useWebGLAvailable();
  const reduced = usePrefersReducedMotion();
  const pageVisible = usePageVisible();
  const [ref, inView] = useInView<HTMLDivElement>();
  const [degraded, setDegraded] = useState(false);

  const layout = useMemo(() => layoutSurvey(view, domainView), [view, domainView]);
  const frame = useMemo(() => (domainView ? layoutSurvey(domainView, domainView) : layout), [domainView, layout]);
  const labels = useMemo(() => probeLabels(view), [view]);
  const truth = useMemo(() => truthLabels(view), [view]);

  // Scroll-rate input goes through a ref: the frame loop reads it, React never re-renders the scene for it.
  const progress = useRef(poseProgress);
  useEffect(() => {
    progress.current = poseProgress;
  }, [poseProgress]);

  const [sonar] = useState(createSonarInput);
  const [orbit] = useState(() => ({ yaw: 0, pitch: 0 }));
  const [focus] = useState(() => new Vector3());
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  const [selectFn] = useState(() => (id: string) => onSelectRef.current?.(id));
  const [readyFn] = useState(() => () => onReadyRef.current?.());

  // ---- the one verb: press-and-hold charges a sonar pulse; release sends it. Run pages also drag-orbit.
  useEffect(() => {
    const el = ref.current;
    if (!el || webgl !== true) return;
    const target: HTMLElement | Window = interactive ? el : window;
    let sx = 0;
    let sy = 0;
    let dragging = false;
    let id = -1;
    const toNdc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      sonar.ndc.set(((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1, -((e.clientY - r.top) / Math.max(1, r.height)) * 2 + 1);
      sonar.hasPointer = inside;
      return inside;
    };
    const blocked = (e: Event) => !!(e.target as Element | null)?.closest?.("a,button,input,textarea,select,label,summary,[data-no-sonar]");
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || blocked(e) || !toNdc(e)) return;
      id = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      dragging = false;
      sonar.holding = true;
      sonar.holdStart = performance.now();
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || e.pointerId === id) toNdc(e);
      if (!sonar.holding || e.pointerId !== id) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!dragging && Math.hypot(dx, dy) > 8) {
        dragging = true;
        // A touch that moves is a scroll; a mouse that moves on a run page is an orbit.
        if (!(interactive && e.pointerType === "mouse")) sonar.holding = false;
      }
      if (dragging && interactive && e.pointerType === "mouse") {
        orbit.yaw = Math.max(-1.05, Math.min(1.05, orbit.yaw - (e.movementX / Math.max(1, el.clientWidth)) * 2.4));
        orbit.pitch = Math.max(-0.25, Math.min(0.45, orbit.pitch + (e.movementY / Math.max(1, el.clientHeight)) * 1.6));
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      if (sonar.holding && !dragging) sonar.release = { charge: Math.min(1, (performance.now() - sonar.holdStart) / 1100) };
      sonar.holding = false;
    };
    const cancel = () => {
      sonar.holding = false;
      id = -1;
    };
    const leave = () => {
      sonar.hasPointer = false;
    };
    target.addEventListener("pointerdown", down as EventListener);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    document.addEventListener("pointerleave", leave);
    return () => {
      target.removeEventListener("pointerdown", down as EventListener);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.removeEventListener("pointerleave", leave);
    };
  }, [interactive, sonar, orbit, webgl, ref]);

  if (webgl === false) return null;
  const running = inView && pageVisible;
  const tier = quality === "full" && !degraded ? "full" : "lite";
  const dpr = tier === "full" ? DPR_FULL : degraded ? DPR_MIN : DPR_LITE;
  const res = quality === "full" ? 256 : 128;
  const animate = !reduced && quality !== "poster";
  const summary =
    ariaLabel ??
    `Survey map of the run: ${view.experiments.length} probes, ${view.experiments.filter((x) => x.status === "keep").length} kept. Height is the cross-validated score.`;

  return (
    <div ref={ref} className={className} role="img" aria-label={summary} style={{ background: SURVEY.void, touchAction: interactive ? "none" : undefined }}>
      {webgl && (
        <Canvas
          dpr={dpr}
          frameloop={!running ? "never" : reduced || quality === "poster" ? "demand" : "always"}
          gl={GL}
          camera={CAMERA}
          flat
          aria-hidden
          style={{ touchAction: interactive ? "none" : "pan-y" }}
        >
          <color attach="background" args={[SURVEY.void]} />
          {quality === "full" && <PerformanceMonitor flipflops={2} onDecline={() => setDegraded(true)} />}
          {quality === "poster" && <PosterStop />}
          <Suspense fallback={null}>
            <SurveyWorld
              layout={layout}
              frame={frame}
              pose={pose}
              progress={progress}
              selectedId={selectedId}
              onSelect={selectFn}
              interactive={interactive}
              headline={headline}
              labels={labels}
              truthLabels={truth}
              res={res}
              animate={animate}
              sonar={sonar}
              orbit={orbit}
              onReady={readyFn}
              focus={focus}
              scrub={scrub ?? null}
              ghost={ghost}
            />
          </Suspense>
          <Post tier={tier} pose={pose} focus={focus} />
        </Canvas>
      )}
    </div>
  );
}
