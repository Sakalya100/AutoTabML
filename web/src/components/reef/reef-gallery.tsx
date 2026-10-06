"use client";

/**
 * Many small reefs on one page with ONE WebGL context: <ReefGallery> owns a single fixed, transparent Canvas;
 * each <ReefThumbnail> is a drei <View> that scissors its own scene into its DOM rect.
 */
import { PerspectiveCamera, View } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { createContext, useContext, useRef, type ReactNode } from "react";
import type { RunView } from "@/lib/run-state";
import type { ReefLayout } from "@/lib/scene/contract";
import type { ColumnKind } from "@/lib/schema";
import { usePrefersReducedMotion, useWebGLAvailable } from "@/lib/scene/webgl";
import { ReefWorld } from "./reef-world";

const GalleryGL = createContext<boolean>(false);

export function ReefGallery({ children, className }: { children: ReactNode; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const webgl = useWebGLAvailable();
  return (
    <div ref={root} className={`relative isolate ${className ?? ""}`}>
      <div className="relative z-[1]">
        <GalleryGL.Provider value={!!webgl}>{children}</GalleryGL.Provider>
      </div>
      {webgl && (
        <Canvas
          eventSource={root as React.RefObject<HTMLElement>}
          dpr={[1, 1.75]}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance", stencil: false }}
          flat
          aria-hidden
          // Under the gallery content (inside this isolated stacking context) so card text and overlays sit on top;
          // thumbnails leave their frame transparent and each View scissors its own abyss into it.
          style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0 }}
        >
          <View.Port />
        </Canvas>
      )}
    </div>
  );
}

export interface ReefThumbnailProps {
  layout: ReefLayout;
  phase: RunView["phase"];
  columnKinds?: ColumnKind[];
  /** aria-label summary of the run. */
  label: string;
  className?: string;
}

export function ReefThumbnail({ layout, phase, columnKinds = [], label, className }: ReefThumbnailProps) {
  const webgl = useContext(GalleryGL);
  const reduced = usePrefersReducedMotion();
  return (
    <div role="img" aria-label={label} className={className} style={webgl ? undefined : { background: "radial-gradient(120% 90% at 50% 0%, #0b2a3d 0%, #03060d 70%)" }}>
      {webgl && (
        <View className="absolute inset-0">
          <PerspectiveCamera makeDefault fov={34} near={0.1} far={220} position={[10, 6, 14]} />
          <ReefWorld layout={layout} phase={phase} columnKinds={columnKinds} currentId={null} lite animate={!reduced} autoRotate />
        </View>
      )}
      {/* The View draws a square scissor rect; a page-coloured ring masks it to the frame's rounded corners. */}
      {webgl && <div aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[0_0_0_6px_var(--paper)]" />}
    </div>
  );
}
