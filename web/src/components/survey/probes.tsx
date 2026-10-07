"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import { Color, CylinderGeometry, IcosahedronGeometry, InstancedMesh, MeshBasicMaterial, MeshStandardMaterial, Object3D } from "three";
import { SURVEY, type SurveyProbe } from "@/lib/survey/contract";
import { hash01 } from "@/lib/survey/layout";
import { MAX_RINGS, sameProps, useSurvey } from "./shared";

const MAX = 512;
const DROP = 0.55; // seconds of free fall
const DROP_H = 4.5;

const STAKE_H: Record<string, number> = { keep: 1.05, discard: 0.55, crash: 0.34, running: 0.8 };
/** The shaft is sunk this far into the ground, so on any slope its foot is seated (never floating). */
const SEAT = 0.12;
const RING_R = 0.22;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Survey stakes, one instance per probe: a slim shaft and a head. Kept = a warm lantern (an emissive orb that blooms)
 * with a benchmark ring painted on the ground by the terrain shader (so it hugs the slope); discard = a slim dark stake
 * with a small bone cap; crash = a toppled stake with an ember head.
 *
 * Run pages: a new stake drops onto the ground and the ground answers with one ripple. Landing (scroll-driven): every
 * stake is in place from the first frame; as the bead reaches a keep its lantern lights up, keeps ahead sit dimmer.
 * Any stake the bead rests on melts away under it (no stake through the mercury). No per-frame allocation.
 */
export const Probes = memo(function Probes({ probes, selectedId }: { probes: SurveyProbe[]; selectedId: string | null }) {
  const { field, u, animate, scrub } = useSurvey();
  const clock = useThree((s) => s.clock);
  const shafts = useRef<InstancedMesh>(null);
  const heads = useRef<InstancedMesh>(null);
  const landT = useRef(new Map<string, number>());
  const first = useRef(true);
  /** Climb index of each probe (keeps only, in order), else -1. */
  const keepIdx = useMemo(() => {
    let k = 0;
    return probes.map((p) => (p.status === "keep" ? k++ : -1));
  }, [probes]);
  const lit = useRef(new Float32Array(MAX).fill(-1));

  const geo = useMemo(() => {
    const shaft = new CylinderGeometry(0.014, 0.022, 1, 8, 1, true);
    shaft.translate(0, 0.5, 0);
    const head = new IcosahedronGeometry(0.05, 2);
    return { shaft, head };
  }, []);
  const mats = useMemo(
    () => ({
      shaft: new MeshStandardMaterial({ color: "#ffffff", roughness: 0.5, metalness: 0.25, envMapIntensity: 0.3 }),
      head: new MeshBasicMaterial({ color: "#ffffff", toneMapped: false }),
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

  // New probes start their drop (run pages); colours are written once per probe-set change.
  useEffect(() => {
    const now = clock.getElapsedTime();
    const seen = landT.current;
    const still = !!scrub; // the landing shows the complete run, standing, from the first frame
    let latest: SurveyProbe | null = null;
    let latestT = -Infinity;
    probes.forEach((p, i) => {
      if (seen.has(p.id)) return;
      const t = !animate || still ? -100 : first.current ? now + 0.35 + i * 0.045 : now;
      seen.set(p.id, t);
      if (t > latestT) {
        latestT = t;
        latest = p;
      }
    });
    for (const id of [...seen.keys()]) if (!probes.some((p) => p.id === id)) seen.delete(id);
    if (latest && animate && !still && !first.current) {
      const p = latest as SurveyProbe;
      u.uLand.value.set(p.pos[0], p.pos[2], latestT + DROP, 1);
    }
    first.current = false;
    lit.current.fill(-1); // force the lantern colours to be rewritten
    const c = new Color();
    const bone = new Color(SURVEY.contour);
    const crash = new Color(SURVEY.crash);
    const signal = new Color(SURVEY.signal);
    probes.forEach((p, i) => {
      if (p.status === "crash") c.copy(crash).multiplyScalar(3);
      else if (p.status === "running") c.copy(signal).multiplyScalar(1.6);
      else c.copy(bone).multiplyScalar(0.22 + (p.score01 ?? 0) * 0.3);
      if (p.id === selectedId) c.multiplyScalar(2.2);
      heads.current?.setColorAt(i, c);
      if (p.status === "keep") c.copy(signal).multiplyScalar(0.5);
      else c.copy(bone).multiplyScalar(p.status === "crash" ? 0.1 : 0.16);
      shafts.current?.setColorAt(i, c);
    });
    for (const m of [heads.current, shafts.current]) if (m?.instanceColor) m.instanceColor.needsUpdate = true;
  }, [probes, selectedId, animate, clock, u, scrub]);

  useEffect(() => () => void (u.uRingN.value = 0), [u]);

  const dummy = useMemo(() => new Object3D(), []);
  const col = useMemo(() => new Color(), []);
  const signal = useMemo(() => new Color(SURVEY.signal), []);
  useFrame((state) => {
    const S = shafts.current;
    const H = heads.current;
    if (!S || !H) return;
    const now = state.clock.getElapsedTime();
    const n = Math.min(probes.length, MAX);
    S.count = n;
    H.count = n;
    const bead = u.uBead.value;
    const beadOn = bead.w > 0;
    const beadT = scrub?.current?.beadT ?? null;
    let rings = 0;
    let headsDirty = false;
    for (let i = 0; i < n; i++) {
      const p = probes[i];
      const t0 = landT.current.get(p.id) ?? -100;
      const t = now - t0;
      const x = p.pos[0];
      const z = p.pos[2];
      const ground = field.sample(x, z);
      const k = Math.min(1, Math.max(0, t / DROP));
      const fall = t < 0 ? 1e3 : (1 - k * k) * DROP_H;
      // Ease in while it falls (grows from nothing over the first part of the drop): a new stake never pops.
      const grow = t < 0 ? 0 : 1 - (1 - Math.min(1, t / (DROP * 0.7))) ** 3;
      // The bead marks the probe it rests on: that stake melts away as the mercury arrives (and back as it leaves).
      const near = beadOn ? Math.hypot(x - bead.x, z - bead.z) : 1e3;
      const melt = smooth(0.3, 0.75, near);
      const g = (t < 0 ? 0 : grow) * melt;
      const h = STAKE_H[p.status] ?? 0.6;
      const sel = p.id === selectedId;
      const hover = p.status === "running" ? 1.1 + Math.sin(now * 2) * 0.08 : 0;
      const keep = p.status === "keep";

      // Lantern: lit once the bead has reached this keep (landing), always lit elsewhere.
      const ki = keepIdx[i];
      const on = ki < 0 ? 1 : beadT == null ? 1 : 0.16 + 0.84 * smooth(ki - 0.3, ki - 0.02, beadT);
      if (keep && Math.abs(on - lit.current[i]) > 0.004) {
        lit.current[i] = on;
        col.copy(signal).multiplyScalar((p.isBest ? 6.5 : 4) * on * (sel ? 1.8 : 1));
        H.setColorAt(i, col);
        headsDirty = true;
      }

      // shaft, sunk into the ground so its foot is seated on any slope
      dummy.position.set(x, ground + fall + hover - SEAT, z);
      if (p.status === "crash") {
        const a = hash01(`crash:${p.id}`) * Math.PI * 2;
        dummy.rotation.set(Math.cos(a) * 1.05, 0, Math.sin(a) * 1.05);
      } else dummy.rotation.set(0, 0, 0);
      dummy.scale.set(g, (h + SEAT) * g, g);
      dummy.updateMatrix();
      S.setMatrixAt(i, dummy.matrix);

      // head at the top of the shaft: a lantern orb for keeps, a small cap otherwise
      const s = (keep ? 1.45 + 0.25 * on : 0.62) * (sel ? 1.5 : 1);
      if (p.status === "crash") dummy.position.set(x, ground + fall + 0.07, z);
      else dummy.position.set(x, ground + fall + hover + h - 0.02, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(s * g);
      dummy.updateMatrix();
      H.setMatrixAt(i, dummy.matrix);

      // benchmark ring on the ground (keeps only), grows in after the drop, painted by the terrain shader
      if (keep && rings < MAX_RINGS) {
        const ringK = t >= 0 ? smooth(0, 0.6, t - DROP) : 0;
        const r = RING_R * (p.isBest ? 1.35 : 1) * (sel ? 1.3 : 1) * (0.6 + 0.4 * ringK);
        u.uRings.value[rings++].set(x, z, r, ringK * melt * (p.isBest ? 1.25 : 0.9) * on);
      }
    }
    u.uRingN.value = rings;
    S.instanceMatrix.needsUpdate = true;
    H.instanceMatrix.needsUpdate = true;
    if (headsDirty && H.instanceColor) H.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={shafts} args={[geo.shaft, mats.shaft, MAX]} frustumCulled={false} />
      <instancedMesh ref={heads} args={[geo.head, mats.head, MAX]} frustumCulled={false} />
    </group>
  );
}, sameProps);
