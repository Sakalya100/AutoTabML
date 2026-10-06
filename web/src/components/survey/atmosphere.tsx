"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: three.js objects, uniforms and frame-loop
   state are mutated imperatively inside useFrame (never during render). */

import { Billboard, Text } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, ShaderMaterial, Vector3 } from "three";
import { SURVEY } from "@/lib/survey/contract";
import { beamFrag, beamVert, cloudFrag, cloudVert, mistFrag, mistVert } from "./shaders";
import { damp, FONT_MONO, sameProps, useSurvey } from "./shared";
import { unitGrid } from "./terrain";

/* ---------------------------------------------------------------- mist: the noise floor */

const MIST_SHEETS = 5;

/**
 * The noise floor. A band of ground-hugging mist around the best height whose thickness is the best's standard
 * error: a probe that lands inside it is indistinguishable from the best (that is why those were discarded).
 */
export const Mist = memo(function Mist({ bestY, thickness }: { bestY: number | null; thickness: number }) {
  const { u, field } = useSurvey();
  const geometry = useMemo(() => unitGrid(64), []);
  const mats = useMemo(
    () =>
      Array.from(
        { length: MIST_SHEETS },
        (_, i) =>
          new ShaderMaterial({
            uniforms: {
              uTime: u.uTime,
              uFieldA: u.uFieldA,
              uFieldB: u.uFieldB,
              uMix: u.uMix,
              uWin: u.uWin,
              uY: { value: 0 },
              uHug: { value: 0.3 },
              uOpacity: { value: 0 },
              uColor: { value: new Color(SURVEY.mist).lerp(new Color(SURVEY.cloud), 0.35).multiplyScalar(0.75) },
              uSeed: { value: i * 3.7 },
            },
            vertexShader: mistVert,
            fragmentShader: mistFrag,
            transparent: true,
            depthWrite: false,
          }),
      ),
    [u],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      mats.forEach((m) => m.dispose());
    },
    [geometry, mats],
  );
  const op = useRef(0);
  const sheets = useRef<Group>(null);
  useFrame((_, dt) => {
    const on = bestY != null && thickness > 0;
    op.current = damp(op.current, on ? 1 : 0, 2.5, Math.min(dt, 0.05));
    const t = Math.max(thickness, 0.12);
    mats.forEach((m, i) => {
      const k = i / (MIST_SHEETS - 1);
      m.uniforms.uY.value = (bestY ?? 0) - t + k * t * 1.6;
      m.uniforms.uHug.value = t * 0.9;
      m.uniforms.uOpacity.value = op.current * 0.085;
    });
    if (sheets.current) sheets.current.visible = op.current > 0.004;
  });
  void field;
  return (
    <group ref={sheets}>
      {mats.map((m, i) => (
        <mesh key={i} geometry={geometry} material={m} frustumCulled={false} renderOrder={3} />
      ))}
    </group>
  );
}, sameProps);

/* ---------------------------------------------------------------- the ceiling: a cloud deck */

const CLOUD_LAYERS = [0, 0.22, 0.5];

/** Appears only once the stop rule has fired; descends and settles at the fitted asymptote. */
export const CloudDeck = memo(function CloudDeck({ cloudY, center, size, strength = 1 }: { cloudY: number | null; center: [number, number]; size: number; strength?: number }) {
  const { u, animate } = useSurvey();
  const geometry = useMemo(() => unitGrid(2), []);
  const mats = useMemo(
    () =>
      CLOUD_LAYERS.map(
        (_, i) =>
          new ShaderMaterial({
            uniforms: {
              uTime: u.uTime,
              uLightDir: u.uLightDir,
              uY: { value: 0 },
              uCenter: { value: new Vector3() },
              uSize: { value: 1 },
              uOpacity: { value: 0 },
              uColor: { value: new Color(SURVEY.cloud).multiplyScalar(0.62 - i * 0.08) },
              uSeed: { value: i * 11.3 },
            },
            vertexShader: cloudVert,
            fragmentShader: cloudFrag,
            transparent: true,
            depthWrite: false,
            side: DoubleSide,
          }),
      ),
    [u],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      mats.forEach((m) => m.dispose());
    },
    [geometry, mats],
  );
  const st = useRef({ y: 0, op: 0 });
  const deck = useRef<Group>(null);
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05);
    const s = st.current;
    if (cloudY == null) {
      s.op = damp(s.op, 0, 3, d);
      if (s.op < 0.01) s.y = 0;
    } else {
      if (s.y === 0) s.y = animate ? cloudY + 6 : cloudY;
      s.y = damp(s.y, cloudY, animate ? 0.9 : 1e3, d);
      s.op = damp(s.op, strength, animate ? 1.2 : 1e3, d);
    }
    mats.forEach((m, i) => {
      m.uniforms.uY.value = s.y + CLOUD_LAYERS[i];
      (m.uniforms.uCenter.value as Vector3).set(center[0], 0, center[1]);
      m.uniforms.uSize.value = size;
      m.uniforms.uOpacity.value = s.op * (0.62 - i * 0.12);
    });
    if (deck.current) deck.current.visible = s.op > 0.004;
  });
  return (
    <group ref={deck}>
      {mats.map((m, i) => (
        <mesh key={i} geometry={geometry} material={m} frustumCulled={false} renderOrder={5 + i} />
      ))}
    </group>
  );
}, sameProps);

/* ---------------------------------------------------------------- the locked test: one beam of truth */

export interface TruthLabels {
  cv: string;
  select: string;
  test: string;
  gap: string;
}

/**
 * Once the run is finished: one cold beam sweeps across the summit (once), and a survey rod beside it carries three
 * real heights — CV (amber), select (bone) and the locked test (ice) — with the optimism gap drawn between the last two.
 */
export const Truth = memo(function Truth({
  summit,
  bestY,
  selectY,
  testY,
  labels,
  hidden = false,
}: {
  hidden?: boolean;
  summit: [number, number, number] | null;
  bestY: number | null;
  selectY: number | null;
  testY: number | null;
  labels: TruthLabels | null;
}) {
  const { animate } = useSurvey();
  const clock = useThree((s) => s.clock);
  const on = summit != null && selectY != null && testY != null && bestY != null;
  const t0 = useRef<number | null>(null);
  const beam = useRef<Mesh>(null);
  const rod = useRef<Group>(null);
  const op = useRef(0);

  const beamMat = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { uColor: { value: new Color(SURVEY.truth) }, uOpacity: { value: 0 } },
        vertexShader: beamVert,
        fragmentShader: beamFrag,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      }),
    [],
  );
  const beamGeo = useMemo(() => {
    const g = new CylinderGeometry(0.55, 0.55, 16, 32, 1, true);
    g.translate(0, 8, 0);
    return g;
  }, []);
  const rodGeo = useMemo(() => new CylinderGeometry(0.012, 0.012, 1, 6), []);
  const tickGeo = useMemo(() => new CylinderGeometry(0.11, 0.11, 0.012, 24), []);
  const gapGeo = useMemo(() => new CylinderGeometry(0.035, 0.035, 1, 10), []);
  const m = useMemo(
    () => ({
      rod: new MeshBasicMaterial({ color: new Color(SURVEY.contour).multiplyScalar(0.45), transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
      cv: new MeshBasicMaterial({ color: new Color(SURVEY.signal).multiplyScalar(3), transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
      select: new MeshBasicMaterial({ color: new Color(SURVEY.contour).multiplyScalar(1.1), transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
      test: new MeshBasicMaterial({ color: new Color(SURVEY.truth).multiplyScalar(3.2), transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
      gap: new MeshBasicMaterial({ color: new Color(SURVEY.truth).multiplyScalar(1.4), transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    }),
    [],
  );
  useEffect(
    () => () => {
      [beamGeo, rodGeo, tickGeo, gapGeo].forEach((g) => g.dispose());
      [beamMat, ...Object.values(m)].forEach((x) => x.dispose());
    },
    [beamGeo, rodGeo, tickGeo, gapGeo, beamMat, m],
  );

  useEffect(() => {
    if (on && t0.current == null) t0.current = animate ? clock.getElapsedTime() + 0.4 : -100;
    if (!on) t0.current = null;
  }, [on, animate, clock]);

  // Where the rod stands: just beside the summit, toward the viewer. It is an instrument, drawn through the ground
  // (x-ray) because a locked-test score can sit below every probe the run ever mapped.
  const rodAt = useMemo(() => (on ? ([summit![0] + 0.65 * 1.35, summit![2] + 0.76 * 1.35] as const) : null), [on, summit]);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.05);
    op.current = damp(op.current, on && !hidden ? 1 : 0, animate ? 2 : 1e3, d);
    const B = beam.current;
    if (B && summit) {
      const t = t0.current == null ? -1 : state.clock.getElapsedTime() - t0.current;
      const sweep = Math.min(1, Math.max(0, t / 2.8));
      const e = sweep * sweep * (3 - 2 * sweep);
      B.position.set(summit[0] - 7 + e * 9, 0, summit[2] - 1.5 + e * 2.5);
      const life = t < 0 ? 0 : Math.min(1, t / 0.4) * (1 - Math.min(1, Math.max(0, (t - 2.6) / 1.2)));
      beamMat.uniforms.uOpacity.value = life * 0.55;
      B.visible = life > 0.002;
    }
    const a = op.current;
    m.rod.opacity = a * 0.9;
    m.cv.opacity = a;
    m.select.opacity = a;
    m.test.opacity = a;
    m.gap.opacity = a * 0.85;
    if (rod.current) rod.current.visible = a > 0.01;
  });

  if (!on || !rodAt) return null;
  const top = Math.max(bestY!, selectY!, testY!) + 0.45;
  const ground = Math.min(selectY!, testY!, bestY!) - 0.35;
  const g0 = Math.min(selectY!, testY!);
  const g1 = Math.max(selectY!, testY!);
  return (
    <group>
      <mesh ref={beam} geometry={beamGeo} material={beamMat} renderOrder={9} frustumCulled={false} />
      <group ref={rod} position={[rodAt[0], 0, rodAt[1]]}>
        <mesh renderOrder={20} geometry={rodGeo} material={m.rod} position={[0, (ground + top) / 2, 0]} scale={[1, Math.max(0.01, top - ground), 1]} />
        <mesh renderOrder={21} geometry={tickGeo} material={m.cv} position={[0, bestY!, 0]} />
        <mesh renderOrder={21} geometry={tickGeo} material={m.select} position={[0, selectY!, 0]} />
        <mesh renderOrder={21} geometry={tickGeo} material={m.test} position={[0, testY!, 0]} />
        <mesh renderOrder={21} geometry={gapGeo} material={m.gap} position={[0, (g0 + g1) / 2, 0]} scale={[1, Math.max(0.005, g1 - g0), 1]} />
        {labels && (
          <>
            <MarkerLabel y={bestY!} text={labels.cv} color={SURVEY.signal} />
            <MarkerLabel y={selectY!} text={labels.select} color={SURVEY.contour} />
            <MarkerLabel y={testY!} text={labels.test} color={SURVEY.truth} />
            <MarkerLabel y={(g0 + g1) / 2} text={labels.gap} color={SURVEY.truth} dim />
          </>
        )}
      </group>
    </group>
  );
}, sameProps);

const XRAY_TEXT = new MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true });

function MarkerLabel({ y, text, color, dim = false }: { y: number; text: string; color: string; dim?: boolean }) {
  return (
    <Billboard position={[0, y, 0]}>
    <Text
      font={FONT_MONO}
      position={[0.22, 0, 0]}
      fontSize={0.13}
      anchorX="left"
      anchorY="middle"
      color={color}
      fillOpacity={dim ? 0.6 : 0.95}
      letterSpacing={0.02}
      material={XRAY_TEXT}
      renderOrder={22}
    >
      {text}
    </Text>
    </Billboard>
  );
}
