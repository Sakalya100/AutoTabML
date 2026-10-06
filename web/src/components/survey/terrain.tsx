"use client";

import { useEffect, useMemo } from "react";
import { PlaneGeometry, ShaderMaterial } from "three";
import { terrainFrag, terrainVert } from "./shaders";
import { useSurvey } from "./shared";

/** Unit grid in x/z ∈ [0, 1] with (res − 1) segments: vertex k samples heightfield texel k exactly. */
export function unitGrid(res: number): PlaneGeometry {
  const g = new PlaneGeometry(1, 1, res - 1, res - 1);
  g.rotateX(-Math.PI / 2);
  g.translate(0.5, 0, 0.5);
  return g;
}

/** One plane, displaced in the vertex shader from the heightfield textures; never rebuilt during growth. */
export function Terrain() {
  const { field, u } = useSurvey();
  const geometry = useMemo(() => unitGrid(field.res), [field.res]);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: u,
        vertexShader: terrainVert,
        fragmentShader: terrainFrag,
      }),
    [u],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  // The grid's bounding sphere is the unit square; the shader moves it, so never frustum-cull it.
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={0} />;
}
