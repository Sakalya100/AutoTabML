"use client";

import { createContext, useContext, useEffect, useMemo } from "react";
import { AdditiveBlending, Color, ShaderMaterial, type IUniform, type ShaderMaterialParameters } from "three";
import { REEF } from "@/lib/scene/contract";

/** Uniform objects shared by every material in one reef (one per Canvas/View). */
export interface ReefUniforms {
  uTime: IUniform<number>;
  uFogColor: IUniform<Color>;
  uFogDensity: IUniform<number>;
}

export interface ReefCtx {
  u: ReefUniforms;
  /** false = static, fully grown, no time animation (reduced motion or thumbnails' still frame). */
  animate: boolean;
  lite: boolean;
  /** Seconds since this reef mounted (wall clock, survives frameloop pauses). */
  mountedAt: number;
}

export const ReefContext = createContext<ReefCtx | null>(null);

export function useReef(): ReefCtx {
  const c = useContext(ReefContext);
  if (!c) throw new Error("useReef outside <ReefWorld>");
  return c;
}

export function makeUniforms(): ReefUniforms {
  return { uTime: { value: 0 }, uFogColor: { value: new Color(REEF.abyss) }, uFogDensity: { value: 0.042 } };
}

export const col = (hex: string) => new Color(hex);


/** A ShaderMaterial bound to the shared uniforms, disposed on unmount. `key` rebuilds the material when it changes (uniform *values* are otherwise updated imperatively). */
export function useShaderMaterial(params: ShaderMaterialParameters & { additive?: boolean }, key = ""): ShaderMaterial {
  const { u } = useReef();
  const mat = useMemo(() => {
    const { additive, uniforms, ...rest } = params;
    return new ShaderMaterial({
      ...rest,
      uniforms: { uTime: u.uTime, uFogColor: u.uFogColor, uFogDensity: u.uFogDensity, ...uniforms },
      ...(additive ? { transparent: true, depthWrite: false, blending: AdditiveBlending } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params is a fresh literal each render; `key` is the identity
  }, [u, key]);
  useEffect(() => () => mat.dispose(), [mat]);
  return mat;
}

/** Deterministic PRNG for particle seeds. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const now = () => (typeof performance !== "undefined" ? performance.now() / 1000 : 0);

/** Frame-rate independent exponential approach. */
export const damp = (from: number, to: number, lambda: number, dt: number) => from + (to - from) * (1 - Math.exp(-lambda * dt));

/**
 * One step of a critically damped spring (exact solution, stable for any dt): no overshoot, no oscillation.
 * Returns the new position and writes the new velocity to `out.v`.
 */
export function springStep(x: number, v: number, goal: number, omega: number, dt: number, out: { v: number }): number {
  const e = Math.exp(-omega * dt);
  const d = x - goal;
  const k = (v + omega * d) * dt;
  out.v = (v - omega * k) * e;
  return goal + (d + k) * e;
}
