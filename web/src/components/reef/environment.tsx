"use client";

/* eslint-disable react-hooks/immutability, react-hooks/refs -- R3F idiom: three.js materials/objects are mutated
   imperatively inside useFrame (outside React render); refs seed initial transforms only. */

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { BackSide, BufferAttribute, BufferGeometry, DoubleSide, type Mesh, type Points } from "three";
import { REEF } from "@/lib/scene/contract";
import type { ColumnKind } from "@/lib/schema";
import {
  backdropFrag,
  backdropVert,
  colorPointFrag,
  nutrientVert,
  pointFrag,
  raysFrag,
  raysVert,
  seabedFrag,
  snowVert,
  surfaceFrag,
  surfaceVert,
} from "./shaders";
import { col, damp, mulberry32, useReef, useShaderMaterial } from "./shared";

export function Backdrop() {
  const mat = useShaderMaterial({
    vertexShader: backdropVert,
    fragmentShader: backdropFrag,
    side: BackSide,
    depthWrite: false,
    uniforms: { uAbyss: { value: col(REEF.abyss) }, uDeep: { value: col(REEF.deep) }, uLight: { value: col(REEF.surfaceLight) } },
  });
  return (
    <mesh material={mat} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[90, 32, 24]} />
    </mesh>
  );
}

/** Light shafts: a unit cone scaled to the reef (tweened — the geometry is never rebuilt as a live reef grows). */
export function GodRays({ center, top }: { center: [number, number, number]; top: number }) {
  const { lite, animate } = useReef();
  const ref = useRef<Mesh>(null);
  const cur = useRef({ h: top + 2, x: center[0], z: center[2] });
  // Transforms are owned by useFrame; props only seed them (re-applying props on re-render would pop).
  const [init] = useState(() => ({ pos: [center[0], (top + 2) / 2 - 0.5, center[2]] as [number, number, number], scale: [1, top + 2, 1] as [number, number, number] }));
  const mat = useShaderMaterial({
    vertexShader: raysVert,
    fragmentShader: raysFrag,
    side: DoubleSide,
    additive: true,
    uniforms: { uColor: { value: col(REEF.surfaceLight) }, uIntensity: { value: lite ? 0.09 : 0.11 } },
  });
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const c = cur.current;
    const k = animate ? 1.2 : 1e4;
    c.h = damp(c.h, top + 2, k, dt);
    c.x = damp(c.x, center[0], k, dt);
    c.z = damp(c.z, center[2], k, dt);
    if (ref.current) {
      ref.current.scale.y = c.h;
      ref.current.position.set(c.x, c.h / 2 - 0.5, c.z);
    }
  });
  return (
    <mesh ref={ref} material={mat} position={init.pos} scale={init.scale} renderOrder={2}>
      <cylinderGeometry args={[2.2, 11, 1, lite ? 48 : 96, 1, true]} />
    </mesh>
  );
}

export function Seabed() {
  const mat = useShaderMaterial({
    vertexShader: surfaceVert,
    fragmentShader: seabedFrag,
    uniforms: { uSand: { value: col("#07121c") }, uLight: { value: col(REEF.surfaceLight) }, uLightAmt: { value: 1 } },
  });
  return (
    <mesh material={mat} rotation-x={-Math.PI / 2} position-y={-0.02}>
      <circleGeometry args={[46, 64]} />
    </mesh>
  );
}

/**
 * The water surface seen from below. Hazy and far until the run stops; then it descends to the fitted ceiling
 * and sends one ripple outward ("the ceiling reveals itself").
 */
export function Surface({ surfaceY, hiddenY, center }: { surfaceY: number | null; hiddenY: number; center: [number, number, number] }) {
  const { animate } = useReef();
  const ref = useRef<Mesh>(null);
  const state = useRef({ y: surfaceY ?? hiddenY, reveal: surfaceY == null ? 0 : 1, settledAt: surfaceY == null ? -1 : -100 });
  const mat = useShaderMaterial({
    vertexShader: surfaceVert,
    fragmentShader: surfaceFrag,
    side: DoubleSide,
    additive: true,
    uniforms: {
      uColor: { value: col(REEF.surfaceLight) },
      uReveal: { value: state.current.reveal },
      uPulse: { value: -1 },
      uCenter: { value: center },
    },
  });
  const cxz = useRef<[number, number, number]>([center[0], 0, center[2]]);
  const [init] = useState<[number, number, number]>(() => [center[0], surfaceY ?? hiddenY, center[2]]);

  useFrame((s, dt) => {
    const st = state.current;
    const target = surfaceY ?? hiddenY;
    const d = Math.min(dt, 0.1);
    if (!animate) {
      st.y = target;
      st.reveal = surfaceY == null ? 0 : 1;
    } else {
      st.y = damp(st.y, target, surfaceY == null ? 1.2 : 0.9, d);
      st.reveal = damp(st.reveal, surfaceY == null ? 0 : 1, 1.1, d);
      if (surfaceY != null && st.settledAt === -1 && Math.abs(st.y - target) < 0.06) st.settledAt = s.clock.elapsedTime;
      if (surfaceY == null) st.settledAt = -1;
    }
    const k = animate ? 1.2 : 1e4;
    cxz.current = [damp(cxz.current[0], center[0], k, d), 0, damp(cxz.current[2], center[2], k, d)];
    mat.uniforms.uCenter.value = cxz.current;
    mat.uniforms.uReveal.value = st.reveal;
    mat.uniforms.uPulse.value = st.settledAt >= 0 ? s.clock.elapsedTime - st.settledAt : -1;
    if (ref.current) ref.current.position.set(cxz.current[0], st.y, cxz.current[2]);
  });

  return (
    <mesh ref={ref} material={mat} rotation-x={-Math.PI / 2} position={init} renderOrder={3}>
      <planeGeometry args={[80, 80, 1, 1]} />
    </mesh>
  );
}

export function MarineSnow({ center }: { center: [number, number, number] }) {
  const { lite } = useReef();
  const count = lite ? 420 : 1400;
  const geo = useMemo(() => {
    const r = mulberry32(7);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seeds[i * 4] = r() - 0.5;
      seeds[i * 4 + 1] = r();
      seeds[i * 4 + 2] = r() - 0.5;
      seeds[i * 4 + 3] = r();
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute("aSeed", new BufferAttribute(seeds, 4));
    return g;
  }, [count]);
  useEffect(() => () => geo.dispose(), [geo]);
  const mat = useShaderMaterial({
    vertexShader: snowVert,
    fragmentShader: pointFrag,
    additive: true,
    uniforms: {
      uColor: { value: col("#9fc6d8") },
      uPixel: { value: 2.2 },
      uBox: { value: [34, 18, 34] },
      uOrigin: { value: [center[0], -1, center[2]] },
    },
  });
  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={4} />;
}

/** One stream per profile column (colour by ColumnKind), spiralling into the root. */
export function Nutrients({ kinds, active, root }: { kinds: ColumnKind[]; active: boolean; root: [number, number, number] }) {
  const { lite, animate } = useReef();
  const streams = Math.min(kinds.length, lite ? 16 : 40);
  // The caller derives `kinds` from each playback view: key the geometry by value, not array identity.
  const kindsKey = kinds.join(",");
  const per = lite ? 10 : 26;
  const ref = useRef<Points>(null);
  const geo = useMemo(() => {
    const n = Math.max(1, streams * per);
    const start = new Float32Array(n * 3);
    const ctrl = new Float32Array(n * 3);
    const phase = new Float32Array(n * 2);
    const color = new Float32Array(n * 3);
    const r = mulberry32(11);
    for (let s = 0; s < streams; s++) {
      const a = (s / Math.max(1, streams)) * Math.PI * 2 + 0.4;
      const rad = 10 + r() * 3;
      const sy = 1.2 + r() * 5;
      const c = col(REEF.nutrient[kinds[s]] ?? REEF.nutrient.numeric);
      for (let k = 0; k < per; k++) {
        const i = s * per + k;
        start.set([Math.cos(a) * rad + (r() - 0.5) * 0.8, sy + (r() - 0.5) * 0.8, Math.sin(a) * rad + (r() - 0.5) * 0.8], i * 3);
        // Swirl: the control point is rotated ahead of the start so streams curve into the root.
        const b = a + 0.9;
        ctrl.set([Math.cos(b) * rad * 0.45, sy * 0.5 + 1.2, Math.sin(b) * rad * 0.45], i * 3);
        phase.set([k / per + r() * 0.04, r()], i * 2);
        color.set([c.r, c.g, c.b], i * 3);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aStart", new BufferAttribute(start, 3));
    g.setAttribute("aCtrl", new BufferAttribute(ctrl, 3));
    g.setAttribute("aPhase", new BufferAttribute(phase, 2));
    g.setAttribute("aColor", new BufferAttribute(color, 3));
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kindsKey is the value identity of kinds
  }, [streams, per, kindsKey]);
  useEffect(() => () => geo.dispose(), [geo]);
  const mat = useShaderMaterial({
    vertexShader: nutrientVert,
    fragmentShader: colorPointFrag,
    additive: true,
    uniforms: { uIntensity: { value: 0 }, uPixel: { value: 3.2 }, uRoot: { value: root } },
  });
  const level = useRef(0);
  useFrame((_, dt) => {
    level.current = animate ? damp(level.current, active ? 1 : 0, active ? 1.5 : 0.8, Math.min(dt, 0.1)) : 0;
    mat.uniforms.uIntensity.value = level.current;
    if (ref.current) ref.current.visible = level.current > 0.01;
  });
  if (!streams) return null;
  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} renderOrder={5} visible={false} />;
}
