import { createContext, useContext } from "react";
import { Color, Vector2, Vector3, Vector4 } from "three";
import type { RefObject } from "react";
import { SURVEY, type SurveyScrub } from "@/lib/survey/contract";
import type { FieldState } from "./field-state";

/** Sonar input written by DOM handlers, read by the frame loop (no React state at pointer rate). */
export interface SonarInput {
  holding: boolean;
  holdStart: number;
  /** Pointer in NDC, and whether it is over the canvas. */
  ndc: Vector2;
  hasPointer: boolean;
  /** Set on release; consumed by the frame loop. */
  release: { charge: number } | null;
}

export function createSonarInput(): SonarInput {
  return { holding: false, holdStart: 0, ndc: new Vector2(), hasPointer: false, release: null };
}

/** Uniform objects shared by every material that reads them (one write per frame updates all). */
export function createUniforms() {
  return {
    uTime: { value: 0 },
    uFieldA: { value: null as unknown },
    uFieldB: { value: null as unknown },
    uMix: { value: 1 },
    uWin: { value: new Vector4(0, 0, 1, 2) },
    uLightDir: { value: new Vector3(-0.72, 0.36, -0.42).normalize() },
    uMoon: { value: new Color("#c9d6ea").multiplyScalar(1.9) },
    uBasaltLo: { value: new Color(SURVEY.basaltLo) },
    uBasaltHi: { value: new Color("#3a4350") },
    uContour: { value: new Color(SURVEY.contour) },
    uSignal: { value: new Color(SURVEY.signal) },
    uVoid: { value: new Color(SURVEY.void) },
    uContourSpec: { value: new Vector3(0, 0.4, 1) },
    uSonar: { value: new Vector4(0, 0, -100, 6) },
    uPointer: { value: new Vector3(0, 0, 0) },
    uLand: { value: new Vector4(0, 0, -100, 0) },
    uBead: { value: new Vector4(0, 0, 0, -1) },
    uFog: { value: 0.012 },
    uReveal: { value: 1 },
    uGhost: { value: null as unknown },
    uGhostOn: { value: 0 },
  };
}
export type SharedUniforms = ReturnType<typeof createUniforms>;

export interface SonarPulse {
  id: number;
  t0: number;
  speed: number;
  x: number;
  z: number;
}

export interface SurveyShared {
  field: FieldState;
  u: SharedUniforms;
  sonar: SonarInput;
  pulse: SonarPulse;
  animate: boolean;
  /** Continuous scroll input (landing), or null. Read in frame loops only. */
  scrub: RefObject<SurveyScrub | null> | null;
}

export const SurveyCtx = createContext<SurveyShared | null>(null);
export function useSurvey(): SurveyShared {
  const s = useContext(SurveyCtx);
  if (!s) throw new Error("SurveyCtx missing");
  return s;
}

/** Absolute URLs: troika parses fonts in a worker, where a root-relative path would not resolve. Served from public/. */
const abs = (p: string) => (typeof window === "undefined" ? p : new URL(p, window.location.href).href);
export const FONT_SERIF = abs("/fonts/instrument-serif.ttf");
export const FONT_SERIF_ITALIC = abs("/fonts/instrument-serif-italic.ttf");
export const FONT_MONO = abs("/fonts/jetbrains-mono.ttf");

/** Critically damped scalar step (no allocation). */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/**
 * Props comparator for scene components: primitives by value, (nested) number arrays by value, everything else by
 * identity. Playback hands the world a fresh layout every step; this keeps unchanged parts from re-rendering.
 */
export function sameProps<P extends object>(a: P, b: P): boolean {
  const ka = Object.keys(a) as (keyof P)[];
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!sameValue(a[k], b[k])) return false;
  return true;
}
function sameValue(x: unknown, y: unknown): boolean {
  if (Object.is(x, y)) return true;
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      const p = x[i];
      const q = y[i];
      if (Object.is(p, q)) continue;
      if (Array.isArray(p) && Array.isArray(q) && sameValue(p, q)) continue;
      return false;
    }
    return true;
  }
  return false;
}
