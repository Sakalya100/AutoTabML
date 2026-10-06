"use client";

/**
 * The one place that loads the survey world (client only, code-split). Run pages and the gallery code against
 * SurveyCanvasProps and render this; the skeleton below holds the frame while the world's code loads.
 */
import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { SurveyCanvasProps } from "@/lib/survey/contract";

export const SurveyCanvas: ComponentType<SurveyCanvasProps> = dynamic(() => import("./survey/survey-canvas"), {
  ssr: false,
  loading: () => <SurveySkeleton />,
});

/** Shown while the world's code and shaders load: the void with a faint ground line. */
export function SurveySkeleton() {
  return (
    <div className="absolute inset-0 overflow-hidden bg-[#05070a]" aria-hidden>
      <div className="absolute inset-x-[12%] top-[58%] h-px animate-pulse bg-gradient-to-r from-transparent via-[#d9d3c4]/25 to-transparent" />
      <p className="absolute inset-x-0 top-[62%] text-center font-mono text-[10px] uppercase tracking-[0.24em] text-[#d9d3c4]/35">surveying…</p>
    </div>
  );
}
