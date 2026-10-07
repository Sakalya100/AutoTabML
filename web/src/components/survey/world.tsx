"use client";

/* eslint-disable react-hooks/immutability, react-hooks/refs -- R3F idiom: three.js objects, uniforms and frame-loop
   state are mutated imperatively inside useFrame (never during render). */

import { Environment, Lightformer } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, type RefObject } from "react";
import { PerspectiveCamera, Raycaster, Vector3 } from "three";
import { SURVEY, type SurveyPose } from "@/lib/survey/contract";
import { terrainKey, type SurveyLayoutFull } from "@/lib/survey/layout";
import { cameraPose, frameMetrics } from "@/lib/survey/poses";
import { CloudDeck, Mist, Truth, type TruthLabels } from "./atmosphere";
import { Bead, ClimbPath } from "./bead";
import { FieldState } from "./field-state";
import { Probes } from "./probes";
import { createUniforms, SurveyCtx, type SonarInput, type SurveyShared } from "./shared";
import { Terrain } from "./terrain";
import { Headline, ProbeLabels, type ProbeLabel } from "./type";

export interface WorldProps {
  layout: SurveyLayoutFull;
  frame: SurveyLayoutFull;
  pose: SurveyPose;
  progress: RefObject<number>;
  selectedId: string | null;
  onSelect?: (id: string) => void;
  interactive: boolean;
  headline: string | null;
  labels: Map<string, ProbeLabel>;
  truthLabels: TruthLabels | null;
  res: number;
  animate: boolean;
  sonar: SonarInput;
  /** Drag-orbit offsets (run pages), written by the DOM handlers. */
  orbit: { yaw: number; pitch: number };
  onReady?: () => void;
  focus: Vector3;
}

/** Critically damped spring per component (ω rad/s): long, settled moves with no overshoot. */
class Spring3 {
  x = new Vector3();
  v = new Vector3();
  step(target: Vector3, w: number, dt: number) {
    // v' = -2ωv - ω²(x - target)  (semi-implicit Euler, sub-stepped for stability)
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v.x += (-2 * w * this.v.x - w * w * (this.x.x - target.x)) * h;
      this.v.y += (-2 * w * this.v.y - w * w * (this.x.y - target.y)) * h;
      this.v.z += (-2 * w * this.v.z - w * w * (this.x.z - target.z)) * h;
      this.x.addScaledVector(this.v, h);
    }
  }
  snap(t: Vector3) {
    this.x.copy(t);
    this.v.set(0, 0, 0);
  }
}

/** Memoised: scroll-rate pose progress arrives through a ref, so scrolling never re-renders the scene graph. */
export const SurveyWorld = memo(function SurveyWorld(props: WorldProps) {
  const { layout, frame, res, animate, sonar } = props;
  const u = useMemo(() => createUniforms(), []);
  const field = useMemo(() => new FieldState(res, frame.bounds), [res, frame.bounds]);
  useEffect(() => () => field.dispose(), [field]);
  const shared: SurveyShared = useMemo(() => ({ field, u, sonar, pulse: { id: 0, t0: -100, speed: 6, x: 0, z: 0 }, animate }), [field, u, sonar, animate]);

  // Rebuild the heightfield only when the probe set changes (in render, so children read the new ground at once).
  const key = terrainKey(layout);
  const firstField = useRef(true);
  useMemo(() => {
    field.update(layout, frame.bounds, key, animate && !firstField.current);
    firstField.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the identity of the probe set
  }, [field, key, animate]);
  u.uFieldA.value = field.texA;
  u.uFieldB.value = field.texB;
  u.uContourSpec.value.set(frame.contour.base, frame.contour.step, 1);

  const m = frameMetrics(frame);
  const portrait = useThree((st) => st.size.width < st.size.height);
  const finalSummit = layout.bead ?? null;

  return (
    <SurveyCtx.Provider value={shared}>
      <Driver {...props} shared={shared} />
      <directionalLight position={[-7.2, 3.6, -4.2]} intensity={2.4} color="#c9d6ea" />
      <ambientLight intensity={0.05} color="#7f95ad" />
      <StudioEnv />
      <Terrain />
      <Probes probes={layout.probes} selectedId={props.selectedId} />
      <ClimbPath climb={layout.climb} fieldKey={key} />
      <Bead target={layout.bead} />
      <Mist bestY={layout.bestY} thickness={layout.mist} />
      <CloudDeck
        cloudY={layout.cloudY}
        center={finalSummit ? [finalSummit[0], finalSummit[2]] : [m.cx, m.cz]}
        size={Math.max(10, m.span * 1.25)}
        strength={CLOUD_STRENGTH[props.pose] ?? 0.25}
      />
      <Truth summit={finalSummit} bestY={layout.bestY} selectY={layout.selectY} testY={layout.testY} labels={props.truthLabels} hidden={props.pose === "chart"} />
      <Headline
        text={props.headline}
        at={[m.cx, 0.04, frame.bounds.maxZ + (portrait ? 6.2 : 3.9)]}
        size={Math.min(1.8, Math.max(0.8, m.span * 0.082)) * (portrait ? 1.3 : 1)}
        width={m.span * (portrait ? 1.15 : 1.6)}
        stacked={portrait}
      />
      <ProbeLabels probes={layout.probes} labels={props.labels} hits={hits} selectedId={props.selectedId} />
    </SurveyCtx.Provider>
  );
});

/**
 * How present the ceiling is per framing: it is the subject of "ceiling"; elsewhere it is a thin cap over the summit
 * so the relief, contours and moonlight carry the image (and the top-down chart is clear).
 */
const CLOUD_STRENGTH: Partial<Record<SurveyPose, number>> = {
  ceiling: 1,
  truth: 0.3,
  mist: 0.35,
  climb: 0.3,
  overview: 0.1,
  approach: 0.22,
  orbit: 0.22,
  "first-probe": 0.25,
  chart: 0,
};

/**
 * The procedural studio the mercury reflects. Memoised with no props on purpose: drei's <Environment frames={1}>
 * re-renders its cube camera (6 faces + PMREM) whenever its children change identity — which, unmemoised, was every
 * replay step and the cause of one dropped frame per step while scrubbing.
 */
const StudioEnv = memo(function StudioEnv() {
  return (
  <Environment resolution={128} frames={1}>
    {/* Soft surround fill: liquid metal only shows what it reflects, and against an all-black studio the bead read
        as a black ball with a few highlights. Four dim, wide walls + a cool sky panel give it a silver body from any
        camera pose without adding geometry to the scene. */}
    <Lightformer form="rect" intensity={0.55} color="#7f8fa3" scale={[40, 10, 1]} position={[0, 2, -14]} />
    <Lightformer form="rect" intensity={0.45} color="#6b7a8d" scale={[40, 10, 1]} position={[0, 2, 14]} rotation-y={Math.PI} />
    <Lightformer form="rect" intensity={0.45} color="#6b7a8d" scale={[40, 10, 1]} position={[-14, 2, 0]} rotation-y={Math.PI / 2} />
    <Lightformer form="rect" intensity={0.45} color="#6b7a8d" scale={[40, 10, 1]} position={[14, 2, 0]} rotation-y={-Math.PI / 2} />
    <Lightformer form="rect" intensity={0.9} color="#c9d6e6" scale={[40, 40, 1]} position={[0, 14, 0]} rotation-x={Math.PI / 2} />
    <Lightformer form="rect" intensity={2.6} color="#e4ecf7" scale={[12, 3, 1]} position={[0, 6, -7]} />
    <Lightformer form="rect" intensity={1.8} color="#d5dfec" scale={[14, 14, 1]} position={[0, 9, 0]} rotation-x={Math.PI / 2} />
    <Lightformer form="rect" intensity={1.1} color="#aebccc" scale={[16, 2, 1]} position={[0, 1.5, 8]} rotation-y={Math.PI} />
    <Lightformer form="rect" intensity={1.2} color="#8fa6c0" scale={[2.5, 9, 1]} position={[-7, 1.5, 1]} rotation-y={Math.PI / 2} />
    <Lightformer form="rect" intensity={0.9} color="#5d7088" scale={[2.5, 9, 1]} position={[7, 1.5, -1]} rotation-y={-Math.PI / 2} />
    <Lightformer form="ring" intensity={3} color={SURVEY.signal} scale={1.1} position={[3.5, 0.6, 5]} />
    <Lightformer form="rect" intensity={0.25} color="#1b222b" scale={[30, 30, 1]} position={[0, -4, 0]} rotation-x={-Math.PI / 2} />
  </Environment>
  );
});

/** Module-level map is fine: one survey canvas reads it at a time, and it only holds sonar hit times. */
const hits = new Map<string, number>();

/**
 * The single writer for the camera and the shared uniforms: pose springs, parallax / drag-orbit, sonar charge and
 * pulse, terrain morph. Runs before everything else each frame.
 */
function Driver({ layout, frame, pose, progress, interactive, onSelect, animate, sonar, orbit, onReady, focus, shared }: WorldProps & { shared: SurveyShared }) {
  const { u, field, pulse } = shared;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const tmp = useMemo(
    () => ({
      pos: new Spring3(),
      target: new Spring3(),
      want: new Vector3(),
      wantT: new Vector3(),
      off: new Vector3(),
      ray: new Raycaster(),
      hit: new Vector3(),
      fov: { x: 34, v: 0 },
      par: { x: 0, y: 0 },
      lift: 0,
      first: true,
      hitOk: false,
    }),
    [],
  );

  // Loader gate: compile every program up front, then report the first real frame.
  const readyFired = useRef(false);
  const readyFrames = useRef(-1);
  useEffect(() => {
    let alive = true;
    const go = () => {
      if (alive) readyFrames.current = 2;
    };
    const r = gl as unknown as { compileAsync?: (s: unknown, c: unknown) => Promise<unknown> };
    // compile() walks visible objects only: briefly show the hidden ones (sonar labels, clouds, the truth rod) so
    // their programs are built behind the loader instead of hitching mid-scroll. Restored synchronously.
    const hidden: { visible: boolean }[] = [];
    scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    if (typeof r.compileAsync === "function") r.compileAsync(scene, camera).then(go, go);
    else go();
    for (const o of hidden) o.visible = false;
    return () => {
      alive = false;
    };
  }, [gl, scene, camera]);

  const groundHit = (ndcX: number, ndcY: number): boolean => {
    tmp.ray.setFromCamera({ x: ndcX, y: ndcY } as never, camera);
    const o = tmp.ray.ray.origin;
    const d = tmp.ray.ray.direction;
    let prev = 0;
    for (let t = 0.2; t < 140; t += 0.25 + t * 0.01) {
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      const z = o.z + d.z * t;
      if (y <= field.sample(x, z)) {
        let a = prev;
        let b = t;
        for (let i = 0; i < 8; i++) {
          const mid = (a + b) / 2;
          if (o.y + d.y * mid <= field.sample(o.x + d.x * mid, o.z + d.z * mid)) b = mid;
          else a = mid;
        }
        tmp.hit.set(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
        return true;
      }
      prev = t;
    }
    // Missed the ground (looking at the sky): fall back to the plane y = 0.
    if (d.y < -1e-3) {
      const t = -o.y / d.y;
      tmp.hit.set(o.x + d.x * t, 0, o.z + d.z * t);
      return true;
    }
    return false;
  };

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 1 / 15);
    const now = state.clock.getElapsedTime();
    u.uTime.value = now;
    field.tick(dt);
    u.uMix.value = field.mix;
    u.uWin.value.set(field.win.minX, field.win.minZ, field.win.size, field.res);

    // ---- camera
    const aspect = size.width / Math.max(1, size.height);
    const c = cameraPose(pose, progress.current ?? 0, { frame, now: layout, aspect });
    tmp.want.set(...c.pos);
    tmp.wantT.set(...c.target);
    if (tmp.first || !animate) {
      tmp.pos.snap(tmp.want);
      tmp.target.snap(tmp.wantT);
      tmp.fov.x = c.fov;
      tmp.first = false;
    } else {
      tmp.pos.step(tmp.want, 2.6, dt);
      tmp.target.step(tmp.wantT, 2.9, dt);
      tmp.fov.v += (-2 * 2.6 * tmp.fov.v - 2.6 * 2.6 * (tmp.fov.x - c.fov)) * dt;
      tmp.fov.x += tmp.fov.v * dt;
    }
    // parallax (±2°) toward the pointer, plus the constrained drag-orbit on run pages
    const px = sonar.hasPointer && animate ? sonar.ndc.x : 0;
    const py = sonar.hasPointer && animate ? sonar.ndc.y : 0;
    tmp.par.x += (px - tmp.par.x) * (1 - Math.exp(-3 * dt));
    tmp.par.y += (py - tmp.par.y) * (1 - Math.exp(-3 * dt));
    const yaw = -tmp.par.x * ((2 * Math.PI) / 180) + (interactive ? orbit.yaw : 0);
    const pitch = tmp.par.y * ((1.5 * Math.PI) / 180) + (interactive ? orbit.pitch : 0);
    tmp.off.copy(tmp.pos.x).sub(tmp.target.x);
    const r = tmp.off.length();
    const az = Math.atan2(tmp.off.x, tmp.off.z) + yaw;
    const el = Math.min(1.5, Math.max(-0.2, Math.asin(Math.min(1, Math.max(-1, tmp.off.y / Math.max(r, 1e-6)))) + pitch));
    camera.position.set(tmp.target.x.x + Math.sin(az) * Math.cos(el) * r, tmp.target.x.y + Math.sin(el) * r, tmp.target.x.z + Math.cos(az) * Math.cos(el) * r);
    // Never inside the land. While the camera eases after the bead up a slope it can cut through a ridge; the terrain
    // is one-sided, so from below it vanished and only stakes/path/bead floated on black. Lift the camera so its line
    // of sight to the target clears the ground (sampled where the GPU shows it this frame), then ease that lift so it
    // never pops.
    {
      const cx = camera.position.x;
      const cz = camera.position.z;
      const tx = tmp.target.x.x;
      const ty = tmp.target.x.y;
      const tz = tmp.target.x.z;
      let need = 0;
      for (let k = 0; k < 6; k++) {
        const f = k / 6; // 0 = camera … 5/6 = near the target
        const x = cx + (tx - cx) * f;
        const z = cz + (tz - cz) * f;
        const lineY = camera.position.y + (ty - camera.position.y) * f;
        const margin = k === 0 ? 0.55 : 0.25;
        const ground = field.sample(x, z) + margin;
        if (ground > lineY) need = Math.max(need, (ground - lineY) / Math.max(1 - f, 0.2));
      }
      tmp.lift += (need - tmp.lift) * (1 - Math.exp(-(need > tmp.lift ? 18 : 2.5) * dt));
      if (!animate || tmp.first) tmp.lift = need;
      camera.position.y += Math.max(0, tmp.lift);
    }
    camera.lookAt(tmp.target.x);
    if (Math.abs(camera.fov - tmp.fov.x) > 1e-3) {
      camera.fov = tmp.fov.x;
      camera.updateProjectionMatrix();
    }
    focus.copy(tmp.target.x);

    // ---- sonar
    if (sonar.holding && sonar.hasPointer) {
      const charge = Math.min(1, (performance.now() - sonar.holdStart) / 1100);
      if (groundHit(sonar.ndc.x, sonar.ndc.y)) u.uPointer.value.set(tmp.hit.x, tmp.hit.z, charge);
      else u.uPointer.value.z = charge;
    } else u.uPointer.value.z *= Math.exp(-6 * dt);
    if (sonar.release) {
      const { charge } = sonar.release;
      sonar.release = null;
      if (groundHit(sonar.ndc.x, sonar.ndc.y)) {
        pulse.id++;
        pulse.t0 = now;
        pulse.speed = 2.6 + charge * 5.5;
        pulse.x = tmp.hit.x;
        pulse.z = tmp.hit.z;
        if (animate) u.uSonar.value.set(pulse.x, pulse.z, pulse.t0, pulse.speed);
        hits.clear();
        if (!animate) for (const p of layout.probes) hits.set(p.id, now);
        if (interactive && onSelect) {
          let best: string | null = null;
          let bd = 3.5;
          for (const p of layout.probes) {
            const d = Math.hypot(p.pos[0] - pulse.x, p.pos[2] - pulse.z);
            if (d < bd) {
              bd = d;
              best = p.id;
            }
          }
          if (best) onSelect(best);
        }
      }
    }
    const age = now - pulse.t0;
    if (animate && age >= 0 && age < 3.4) {
      const rr = age * pulse.speed;
      const tol = 0.3 + pulse.speed * dt;
      for (const p of layout.probes) {
        if (hits.has(p.id)) continue;
        if (Math.abs(Math.hypot(p.pos[0] - pulse.x, p.pos[2] - pulse.z) - rr) < tol || Math.hypot(p.pos[0] - pulse.x, p.pos[2] - pulse.z) < rr) hits.set(p.id, now);
      }
    }

    // ---- ready
    if (readyFrames.current > 0) readyFrames.current--;
    else if (readyFrames.current === 0 && !readyFired.current) {
      readyFired.current = true;
      onReady?.();
    }
  }, -10);

  return null;
}
