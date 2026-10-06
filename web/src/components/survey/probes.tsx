"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import {
  Color,
  CylinderGeometry,
  InstancedMesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  RingGeometry,
} from "three";
import { SURVEY, type SurveyProbe } from "@/lib/survey/contract";
import { hash01 } from "@/lib/survey/layout";
import { sameProps, useSurvey } from "./shared";

const MAX = 512;
const DROP = 0.55; // seconds of free fall
const DROP_H = 4.5;

const STAKE_H: Record<string, number> = { keep: 1.05, discard: 0.55, crash: 0.34, running: 0.8 };

/**
 * Survey stakes, one instance per probe: a thin shaft, a head, and (for keeps) a benchmark ring on the ground.
 * Kept = amber signal (emissive, blooms), discard = dim bone stake, crash = a toppled stake with an ember head.
 * Landing: the stake drops onto the ground and the ground answers with one ripple. No per-frame allocation.
 */
export const Probes = memo(function Probes({ probes, selectedId }: { probes: SurveyProbe[]; selectedId: string | null }) {
  const { field, u, animate } = useSurvey();
  const clock = useThree((s) => s.clock);
  const shafts = useRef<InstancedMesh>(null);
  const heads = useRef<InstancedMesh>(null);
  const rings = useRef<InstancedMesh>(null);
  const landT = useRef(new Map<string, number>());
  const first = useRef(true);

  const geo = useMemo(() => {
    const shaft = new CylinderGeometry(0.018, 0.024, 1, 6, 1, true);
    shaft.translate(0, 0.5, 0);
    const head = new OctahedronGeometry(0.075, 0);
    const ring = new RingGeometry(0.2, 0.235, 40);
    ring.rotateX(-Math.PI / 2);
    return { shaft, head, ring };
  }, []);
  const mats = useMemo(
    () => ({
      shaft: new MeshStandardMaterial({ color: "#ffffff", roughness: 0.55, metalness: 0.2, envMapIntensity: 0.25 }),
      head: new MeshBasicMaterial({ color: "#ffffff", toneMapped: false }),
      ring: new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }),
    }),
    [],
  );
  useEffect(
    () => () => {
      Object.values(geo).forEach((g) => g.dispose());
      Object.values(mats).forEach((m) => m.dispose());
    },
    [geo, mats],
  );

  // New probes start their drop; colours are written once per probe-set change.
  useEffect(() => {
    const now = clock.getElapsedTime();
    const seen = landT.current;
    let latest: SurveyProbe | null = null;
    let latestT = -Infinity;
    probes.forEach((p, i) => {
      if (seen.has(p.id)) return;
      const t = !animate ? -100 : first.current ? now + 0.35 + i * 0.045 : now;
      seen.set(p.id, t);
      if (t > latestT) {
        latestT = t;
        latest = p;
      }
    });
    for (const id of [...seen.keys()]) if (!probes.some((p) => p.id === id)) seen.delete(id);
    if (latest && animate && !first.current) {
      const p = latest as SurveyProbe;
      u.uLand.value.set(p.pos[0], p.pos[2], latestT + DROP, 1);
    }
    first.current = false;

    const c = new Color();
    const signal = new Color(SURVEY.signal);
    const bone = new Color(SURVEY.contour);
    const crash = new Color(SURVEY.crash);
    probes.forEach((p, i) => {
      const sel = p.id === selectedId;
      if (p.status === "keep") c.copy(signal).multiplyScalar(p.isBest ? 7 : 3.6);
      else if (p.status === "crash") c.copy(crash).multiplyScalar(3);
      else if (p.status === "running") c.copy(signal).multiplyScalar(1.6);
      else c.copy(bone).multiplyScalar(0.16 + (p.score01 ?? 0) * 0.22);
      if (sel) c.multiplyScalar(2.2);
      heads.current?.setColorAt(i, c);
      if (p.status === "keep") c.copy(signal).multiplyScalar(0.55);
      else c.copy(bone).multiplyScalar(p.status === "crash" ? 0.12 : 0.22);
      shafts.current?.setColorAt(i, c);
      c.copy(signal).multiplyScalar(p.isBest ? 2.2 : 1.2);
      rings.current?.setColorAt(i, c);
    });
    for (const m of [heads.current, shafts.current, rings.current]) if (m?.instanceColor) m.instanceColor.needsUpdate = true;
  }, [probes, selectedId, animate, clock, u]);

  const dummy = useMemo(() => new Object3D(), []);
  useFrame((state) => {
    const S = shafts.current;
    const H = heads.current;
    const R = rings.current;
    if (!S || !H || !R) return;
    const now = state.clock.getElapsedTime();
    const n = Math.min(probes.length, MAX);
    S.count = n;
    H.count = n;
    R.count = n;
    for (let i = 0; i < n; i++) {
      const p = probes[i];
      const t0 = landT.current.get(p.id) ?? -100;
      const t = now - t0;
      const x = p.pos[0];
      const z = p.pos[2];
      const ground = field.sample(x, z);
      const k = Math.min(1, Math.max(0, t / DROP));
      const fall = t < 0 ? 1e3 : (1 - k * k) * DROP_H;
      // The probe the mercury rests on is marked by the bead itself (and its ring): no stake through the bead.
      const hidden = t < 0 || p.isBest;
      const h = STAKE_H[p.status] ?? 0.6;
      const sel = p.id === selectedId;
      const hover = p.status === "running" ? 1.1 + Math.sin(now * 2) * 0.08 : 0;

      // shaft
      dummy.position.set(x, ground + fall + hover - 0.04, z);
      if (p.status === "crash") {
        const a = hash01(`crash:${p.id}`) * Math.PI * 2;
        dummy.rotation.set(Math.cos(a) * 1.05, 0, Math.sin(a) * 1.05);
      } else dummy.rotation.set(0, 0, 0);
      dummy.scale.set(hidden ? 0 : 1, hidden ? 0 : h, hidden ? 0 : 1);
      dummy.updateMatrix();
      S.setMatrixAt(i, dummy.matrix);

      // head at the top of the shaft
      const s = (p.status === "keep" ? 1.5 : 0.75) * (sel ? 1.6 : 1);
      if (p.status === "crash") dummy.position.set(x, ground + fall + 0.07, z);
      else dummy.position.set(x, ground + fall + hover + h - 0.04, z);
      dummy.rotation.set(0, now * (p.isBest ? 0.6 : 0.25) + i, 0);
      dummy.scale.setScalar(hidden ? 0 : s);
      dummy.updateMatrix();
      H.setMatrixAt(i, dummy.matrix);

      // benchmark ring (keeps only), grows in after the drop
      const ringK = p.status === "keep" && t >= 0 ? Math.min(1, Math.max(0, (t - DROP) / 0.6)) : 0;
      dummy.position.set(x, ground + 0.025, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(ringK * (p.isBest ? 1.5 : 1) * (sel ? 1.4 : 1));
      dummy.updateMatrix();
      R.setMatrixAt(i, dummy.matrix);
    }
    S.instanceMatrix.needsUpdate = true;
    H.instanceMatrix.needsUpdate = true;
    R.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={shafts} args={[geo.shaft, mats.shaft, MAX]} frustumCulled={false} />
      <instancedMesh ref={heads} args={[geo.head, mats.head, MAX]} frustumCulled={false} />
      <instancedMesh ref={rings} args={[geo.ring, mats.ring, MAX]} frustumCulled={false} renderOrder={2} />
    </group>
  );
}, sameProps);
