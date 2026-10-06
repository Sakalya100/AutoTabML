"use client";

/* eslint-disable react-hooks/immutability, react-hooks/refs -- R3F idiom: three.js materials/objects are mutated
   imperatively inside useFrame (outside React render); refs seed initial transforms only. */

import { Billboard, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { DoubleSide, type Group, type Mesh } from "three";
import { REEF } from "@/lib/scene/contract";
import { glowFrag, glowVert, pearlFrag, shellFrag, shellVert } from "./shaders";
import { col, damp, useReef, useShaderMaterial } from "./shared";

/** The noise band around the best tip: a breathing translucent sphere plus a slow orbiting ring. */
export function Halo({ position, radius }: { position: [number, number, number]; radius: number }) {
  const { animate } = useReef();
  const g = useRef<Group>(null);
  const ring = useRef<Mesh>(null);
  const shown = useRef(animate ? 0 : 1);
  const sphere = useShaderMaterial({
    vertexShader: glowVert,
    fragmentShader: glowFrag,
    additive: true,
    uniforms: { uColor: { value: col(REEF.halo) }, uIntensity: { value: 0.55 }, uCore: { value: 0.1 }, uPower: { value: 2.2 } },
  });
  const ringMat = useShaderMaterial({
    vertexShader: glowVert,
    fragmentShader: glowFrag,
    additive: true,
    side: DoubleSide,
    uniforms: { uColor: { value: col(REEF.halo) }, uIntensity: { value: 0.8 }, uCore: { value: 1 }, uPower: { value: 1 } },
  });
  useFrame((s, dt) => {
    const t = s.clock.elapsedTime;
    shown.current = animate ? damp(shown.current, 1, 1.5, Math.min(dt, 0.1)) : 1;
    const breathe = animate ? 1 + 0.06 * Math.sin(t * 1.3) : 1;
    g.current?.scale.setScalar(radius * breathe * shown.current);
    if (ring.current && animate) ring.current.rotation.set(1.2 + 0.15 * Math.sin(t * 0.4), t * 0.25, 0.3);
  });
  return (
    <group ref={g} position={position}>
      <mesh material={sphere} renderOrder={8}>
        <sphereGeometry args={[1, 32, 24]} />
      </mesh>
      <mesh ref={ring} material={ringMat} rotation={[1.2, 0, 0.3]} renderOrder={8}>
        <torusGeometry args={[1.12, 0.012, 6, 96]} />
      </mesh>
    </group>
  );
}

export function SelectionRing({ position }: { position: [number, number, number] }) {
  const { animate } = useReef();
  const ref = useRef<Mesh>(null);
  const mat = useShaderMaterial({
    vertexShader: glowVert,
    fragmentShader: glowFrag,
    additive: true,
    side: DoubleSide,
    uniforms: { uColor: { value: col("#ffffff") }, uIntensity: { value: 0.9 }, uCore: { value: 1 }, uPower: { value: 1 } },
  });
  useFrame((s) => {
    if (!ref.current) return;
    const k = animate ? 1 + 0.1 * Math.sin(s.clock.elapsedTime * 4) : 1;
    ref.current.scale.setScalar(k);
  });
  return (
    <Billboard position={position}>
      <mesh ref={ref} material={mat} renderOrder={9}>
        <torusGeometry args={[0.3, 0.014, 6, 64]} />
      </mesh>
    </Billboard>
  );
}

const HALF = Math.PI / 2;

/**
 * The locked test set: a sealed shell on the seabed. It opens only when the run finishes; the pearl then rises
 * to the test score's height. A thin line joins it to the select marker — that vertical gap is the optimism gap.
 */
export function Shell({
  position,
  open,
  selectY,
  testY,
}: {
  position: [number, number, number];
  open: boolean;
  selectY: number | null;
  testY: number | null;
}) {
  const { animate } = useReef();
  const lid = useRef<Group>(null);
  const pearl = useRef<Group>(null);
  const st = useRef({ open: open && !animate ? 1 : 0, y: open && !animate && testY != null ? testY : 0.02 });
  const shellMat = useShaderMaterial({
    vertexShader: shellVert,
    fragmentShader: shellFrag,
    side: DoubleSide,
    uniforms: { uOuter: { value: col("#3a4f66") }, uOpen: { value: st.current.open } },
  });
  const pearlMat = useShaderMaterial({
    vertexShader: glowVert,
    fragmentShader: pearlFrag,
    uniforms: { uColor: { value: col(REEF.pearl) }, uGlow: { value: 0.3 } },
  });
  const pearlGlow = useShaderMaterial({
    vertexShader: glowVert,
    fragmentShader: glowFrag,
    additive: true,
    uniforms: { uColor: { value: col(REEF.pearl) }, uIntensity: { value: 0.5 }, uCore: { value: 0.05 }, uPower: { value: 2 } },
  });
  const markerMat = useShaderMaterial({
    vertexShader: glowVert,
    fragmentShader: glowFrag,
    additive: true,
    side: DoubleSide,
    uniforms: { uColor: { value: col("#a9cfff") }, uIntensity: { value: 0.9 }, uCore: { value: 1 }, uPower: { value: 1 } },
  });

  useFrame((s, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const t = s.clock.elapsedTime;
    const c = st.current;
    if (animate) {
      c.open = damp(c.open, open ? 1 : 0, 1.6, dt);
      const rise = open && c.open > 0.6 && testY != null ? testY : 0.02;
      c.y = damp(c.y, rise, 0.9, dt);
    } else {
      c.open = open ? 1 : 0;
      c.y = open && testY != null ? testY : 0.02;
    }
    shellMat.uniforms.uOpen.value = c.open;
    // Closed shells breathe very slightly; opening swings the lid back on its hinge.
    if (lid.current) lid.current.rotation.x = -c.open * 1.15 - (animate && !open ? 0.04 + 0.04 * Math.sin(t * 1.2) : 0);
    if (pearl.current) pearl.current.position.y = c.y;
    pearlMat.uniforms.uGlow.value = c.open;
    pearlGlow.uniforms.uIntensity.value = 0.35 * c.open;
  });

  const r = 0.62;
  return (
    <group position={position}>
      {/* lower valve */}
      <mesh material={shellMat} scale={[1, 0.38, 0.86]}>
        <sphereGeometry args={[r, 40, 16, 0, Math.PI * 2, HALF, HALF]} />
      </mesh>
      {/* upper valve, hinged at the back */}
      <group position={[0, 0, -r * 0.86]}>
        <group ref={lid}>
          <mesh material={shellMat} position={[0, 0, r * 0.86]} scale={[1, 0.42, 0.86]}>
            <sphereGeometry args={[r, 40, 16, 0, Math.PI * 2, 0, HALF]} />
          </mesh>
        </group>
      </group>
      <group ref={pearl} position={[0, st.current.y, 0]}>
        <mesh material={pearlMat}>
          <sphereGeometry args={[0.2, 32, 24]} />
        </mesh>
        <mesh material={pearlGlow} renderOrder={8}>
          <sphereGeometry args={[0.3, 24, 16]} />
        </mesh>
      </group>
      {open && selectY != null && testY != null && (
        <>
          <mesh position={[0, selectY, 0]} rotation-x={HALF} material={markerMat}>
            <torusGeometry args={[0.24, 0.012, 6, 48]} />
          </mesh>
          <Line
            points={[
              [0, selectY, 0],
              [0, testY, 0],
            ]}
            color="#cfe9ff"
            lineWidth={1.2}
            dashed
            dashSize={0.08}
            gapSize={0.06}
            transparent
            opacity={0.85}
          />
        </>
      )}
    </group>
  );
}
