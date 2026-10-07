"use client";

import { useFrame } from "@react-three/fiber";
import { Bloom, ChromaticAberration, DepthOfField, EffectComposer, Noise, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing";
import { BlendFunction, ToneMappingMode, type DepthOfFieldEffect } from "postprocessing";
import { memo, useMemo, useRef } from "react";
import { HalfFloatType, Vector2, type Vector3 } from "three";
import type { SurveyPose } from "@/lib/survey/contract";

/**
 * The filmic pass, kept subtle: bloom on emissive only (threshold above 1 in HDR), radial chromatic aberration at the
 * edges, premultiplied grain, vignette, AgX, SMAA. DOF exists only for the two shots that are about distance
 * (orbit, first probe) and eases to zero elsewhere. "lite" drops DOF and CA.
 */
export const Post = memo(function Post({ tier, pose, focus }: { tier: "full" | "lite"; pose: SurveyPose; focus: Vector3 }) {
  const dof = useRef<DepthOfFieldEffect>(null);
  const caOffset = useMemo(() => new Vector2(0.00055, 0.00055), []);
  const full = tier === "full";
  const wantsDof = full && (pose === "orbit" || pose === "first-probe");
  const bokeh = useRef(0);
  useFrame((_, dt) => {
    const d = dof.current;
    if (!d) return;
    bokeh.current += ((wantsDof ? (pose === "orbit" ? 2.2 : 3.2) : 0) - bokeh.current) * (1 - Math.exp(-2.5 * Math.min(dt, 0.05)));
    d.bokehScale = bokeh.current;
    d.target = focus;
  });
  return (
    <EffectComposer multisampling={0} frameBufferType={HalfFloatType} enableNormalPass={false}>
      {full ? <DepthOfField ref={dof} focusRange={5} bokehScale={0} resolutionScale={0.5} /> : <></>}
      <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.25} intensity={0.9} radius={0.72} />
      {full ? <ChromaticAberration offset={caOffset} radialModulation modulationOffset={0.32} /> : <></>}
      <ToneMapping mode={ToneMappingMode.AGX} />
      <Noise premultiply blendFunction={BlendFunction.ADD} opacity={0.32} />
      <Vignette offset={0.3} darkness={0.68} />
      <SMAA />
    </EffectComposer>
  );
});
