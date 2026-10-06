"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: materials are mutated inside useFrame. */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, type Points } from "three";
import { REEF } from "@/lib/scene/contract";
import { hash01 } from "@/lib/scene/layout";
import { burstVert, colorPointFrag } from "./shaders";
import { col, mulberry32, useShaderMaterial } from "./shared";

/** Crash: a brief burst of sparks at the stub (the charred stub itself is part of the tree). */
export function CrashBurst({ id, at }: { id: string; at: readonly number[] }) {
  const ref = useRef<Points>(null);
  const get = useThree((s) => s.get);
  const born = useRef<number | null>(null);
  const key = at.join(",");
  const geo = useMemo(() => {
    const n = 40;
    const r = mulberry32(Math.floor(hash01(id) * 1e6));
    const pos = new Float32Array(n * 3);
    const dir = new Float32Array(n * 3);
    const rnd = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      pos.set([at[0], at[1], at[2]], i * 3);
      const th = r() * Math.PI * 2;
      const ph = Math.acos(2 * r() - 1);
      dir.set([Math.sin(ph) * Math.cos(th), Math.cos(ph) * 0.8 + 0.3, Math.sin(ph) * Math.sin(th)], i * 3);
      rnd.set([r(), r()], i * 2);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("aDir", new BufferAttribute(dir, 3));
    g.setAttribute("aRnd", new BufferAttribute(rnd, 2));
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the value identity of `at`
  }, [id, key]);
  useEffect(() => () => geo.dispose(), [geo]);
  const mat = useShaderMaterial({
    vertexShader: burstVert,
    fragmentShader: colorPointFrag,
    additive: true,
    uniforms: {
      uAge: { value: -1 },
      uLife: { value: 1.6 },
      uSpeed: { value: 1.8 },
      uRise: { value: -0.3 },
      uPixel: { value: 3.2 },
      uColorA: { value: col("#ffd2a0") },
      uColorB: { value: col(REEF.crash) },
    },
  });
  useFrame(() => {
    const now = get().clock.elapsedTime;
    born.current ??= now + 0.5; // after the stub has begun to grow
    const age = now - born.current;
    mat.uniforms.uAge.value = age;
    if (ref.current) ref.current.visible = age > -0.1 && age < 1.8;
  });
  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} renderOrder={7} visible={false} />;
}
