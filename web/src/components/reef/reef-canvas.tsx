"use client";

/**
 * The living reef for one run. Load with next/dynamic({ ssr: false }); render nothing (and let the caller fall
 * back) when WebGL is unavailable — see useWebGLAvailable() in lib/scene/webgl.ts.
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Canvas } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { REEF } from "@/lib/scene/contract";
import type { RunView } from "@/lib/run-state";
import type { ReefSceneProps } from "@/lib/scene/contract";
import { layoutReef } from "@/lib/scene/layout";
import { usePageVisible, usePrefersReducedMotion, useWebGLAvailable } from "@/lib/scene/webgl";
import { columnKinds, describeNode, reefSummary, sceneLabels } from "./describe";
import { ReefWorld, type LabelKey } from "./reef-world";
import { SceneTag } from "./scene-tag";

export interface ReefCanvasProps extends ReefSceneProps {
  /** The complete run (replays): freezes the height scale so tips don't move during playback. */
  domainView?: RunView | null;
  /** Experiment the camera eases toward — pass the user's pick, not the playback cursor. */
  focusId?: string | null;
}

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

export default function ReefCanvas({
  view,
  domainView,
  selectedId = null,
  focusId = null,
  onSelect,
  chapter = "overview",
  quality = "full",
  interactive = true,
  autoRotate = false,
  className,
}: ReefCanvasProps) {
  const webgl = useWebGLAvailable();
  const reduced = usePrefersReducedMotion();
  const pageVisible = usePageVisible();
  const [ref, inView] = useInView<HTMLDivElement>();
  const [coarse] = useState(() => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches);

  const layout = useMemo(() => layoutReef(view, domainView), [view, domainView]);
  const frameLayout = useMemo(() => (domainView ? layoutReef(domainView) : null), [domainView]);
  // Value-stable: playback hands us a new view every tick, but the profile's column kinds rarely change.
  const kindsNow = columnKinds(view.profile ? view : (domainView ?? view));
  const kindsKey = kindsNow.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- kindsKey is the value identity of kindsNow
  const kinds = useMemo(() => kindsNow, [kindsKey]);
  const labels = useMemo(() => (interactive ? sceneLabels(view) : null), [view, interactive]);
  const [hovered, setHovered] = useState<string | null>(null);
  const onHover = useCallback((id: string | null) => setHovered(id), []);
  const hoverInfo = hovered ? describeNode(view, hovered) : null;
  const hoverBest = hovered != null && layout.nodes.find((n) => n.id === hovered)?.isBest;
  const [labelRoot, setLabelRoot] = useState<HTMLDivElement | null>(null);
  const finished = view.phase === "finished";
  const summary = reefSummary(view);

  if (webgl === false) return null;
  const running = inView && pageVisible;
  const full = quality === "full";

  return (
    <div ref={ref} className={className} role="img" aria-label={summary} style={{ background: "#03060d" }}>
      {webgl && (
        <Canvas
          // Fill-rate bound at retina sizes (bloom + MSAA + full-screen water): 1.5x is visually indistinguishable here.
          dpr={[1, full ? 1.5 : 1.25]}
          frameloop={!running ? "never" : reduced ? "demand" : "always"}
          gl={{ antialias: !full, powerPreference: "high-performance", alpha: false, stencil: false }}
          camera={{ fov: 38, near: 0.1, far: 220, position: [10, 6, 14] }}
          flat
          aria-hidden
          style={{ touchAction: coarse ? "pan-y" : "none" }}
        >
          <color attach="background" args={["#03060d"]} />
          <ReefWorld
            layout={layout}
            frameLayout={frameLayout}
            phase={view.phase}
            columnKinds={kinds}
            currentId={view.current?.id ?? null}
            chapter={chapter}
            lite={!full}
            animate={!reduced}
            interactive={interactive}
            controls={interactive && !coarse}
            autoRotate={autoRotate}
            selectedId={selectedId}
            focusId={focusId}
            onSelect={onSelect}
            onHover={onHover}
            labelRoot={interactive ? labelRoot : null}
          />
          {full && (
            <EffectComposer multisampling={4} enableNormalPass={false}>
              <Bloom mipmapBlur intensity={0.75} luminanceThreshold={0.5} luminanceSmoothing={0.35} radius={0.72} resolutionScale={0.5} />
              <Vignette offset={0.28} darkness={0.72} />
            </EffectComposer>
          )}
        </Canvas>
      )}
      {webgl && interactive && labels && (
        // Labels live in the DOM (crisp text, no extra React roots); the scene positions them every frame.
        <div ref={setLabelRoot} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
          {labels.ceiling && <Anchor at="ceiling" align="center"><SceneTag tone="surface">{labels.ceiling}</SceneTag></Anchor>}
          {!finished && labels.sealed && <Anchor at="sealed" align="left"><SceneTag tone="muted">{labels.sealed}</SceneTag></Anchor>}
          {finished && labels.select && <Anchor at="select" align="left"><SceneTag tone="select">{labels.select}</SceneTag></Anchor>}
          {finished && labels.gap && <Anchor at="gap" align="left"><SceneTag tone="gap">{labels.gap}</SceneTag></Anchor>}
          {finished && labels.test && <Anchor at="test" align="right"><SceneTag tone="pearl">{labels.test}</SceneTag></Anchor>}
          {hoverInfo && (
            <Anchor at="tooltip" align="above">
              <div
                className="w-max max-w-[240px] rounded-lg px-3 py-2 text-[12px] leading-snug shadow-lg"
                style={{ background: "rgba(4,10,20,0.88)", border: "1px solid rgba(140,200,230,0.22)", color: "#dcecf5", backdropFilter: "blur(6px)" }}
              >
                <div className="font-mono text-[10px] tracking-wide" style={{ color: "rgba(180,210,230,0.7)" }}>
                  {hovered} · {hoverInfo.status}
                </div>
                <div className="mt-0.5 font-medium">{hoverInfo.title}</div>
                <div className="mt-1 font-mono tabular-nums" style={{ color: hoverBest ? REEF.best : REEF.keep }}>
                  {hoverInfo.score}
                </div>
              </div>
            </Anchor>
          )}
        </div>
      )}
    </div>
  );
}

const ALIGN = {
  center: "translate(-50%, -50%)",
  left: "translate(-100%, -50%)",
  right: "translate(0, -50%)",
  above: "translate(-50%, calc(-100% - 14px))",
} as const;

/** Outer element is moved by the scene's projector; the inner one aligns the content around the anchor point. */
function Anchor({ at, align, children }: { at: LabelKey; align: keyof typeof ALIGN; children: React.ReactNode }) {
  return (
    <div data-label={at} className="absolute top-0 left-0 will-change-transform" style={{ visibility: "hidden" }}>
      <div style={{ transform: ALIGN[align] }}>{children}</div>
    </div>
  );
}
