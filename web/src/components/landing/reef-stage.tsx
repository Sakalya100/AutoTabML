"use client";

import type { ComponentType } from "react";
import { EvolutionChart } from "@/components/evolution-chart";
import type { RunView } from "@/lib/run-state";
import type { ReefCanvasProps } from "@/components/reef/reef-canvas";
import type { SceneChapter } from "@/lib/scene/contract";
import { useWebGLAvailable } from "@/lib/scene/webgl";

/**
 * The fixed full-screen backdrop: a CSS abyss that paints instantly, the WebGL reef on top once it has loaded,
 * and — when WebGL is unavailable — the 2D evolution chart of the same run.
 *
 * `Reef` is the shared ReefCanvas (components/reef), loaded by the caller with next/dynamic ssr:false so three.js
 * never blocks first paint. Passing null keeps the static fallback.
 */
export function ReefStage({
  Reef,
  view,
  full,
  chapter,
  quality,
  reduced,
}: {
  Reef: ComponentType<ReefCanvasProps> | null;
  view: RunView;
  full: RunView;
  chapter: SceneChapter;
  quality: "full" | "lite";
  reduced: boolean;
}) {
  const webgl = useWebGLAvailable();
  return (
    <div className="lp-stage" aria-hidden data-chapter={chapter}>
      <div className="lp-abyss" />
      <div className="lp-rays" />
      <div className="lp-snow" />
      {webgl && Reef ? (
        <Reef view={view} domainView={full} chapter={chapter} quality={quality} interactive={false} autoRotate={!reduced && chapter === "intro"} className="lp-reef" />
      ) : webgl === false || (webgl && !Reef) ? (
        <div className="lp-fallback-chart" data-theme="dark">
          <EvolutionChart view={view} domainView={full} plannedExperiments={full.experiments.length} compact />
        </div>
      ) : null}
      <div className="lp-scrim" />
    </div>
  );
}
