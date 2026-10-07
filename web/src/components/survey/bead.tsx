"use client";

import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import { Color, IcosahedronGeometry, Mesh, MeshPhysicalMaterial, Quaternion, Vector3 } from "three";
import { climbPointXZ } from "@/lib/survey/poses";
import { WOBBLE_BEGIN, WOBBLE_HEAD } from "./shaders";
import { damp, sameProps, useSurvey } from "./shared";

const R = 0.34;
const PATH_COLOR = new Color(2.2, 1.25, 0.38);

/**
 * The agent: a bead of mercury resting on the best-known point. It rolls (really rolls: rotation = distance / r)
 * along the ground to a new best only when the gate keeps a probe. Surface tension: a slow vertex wobble that
 * quickens while it moves.
 *
 * On the landing the bead's place is a pure function of scroll (`scrub.beadT`, an index along the complete run's climb
 * `path`): it rolls in proportion to scroll, forwards and backwards, with no catch-up lag.
 */
export const Bead = memo(function Bead({ target, path }: { target: [number, number, number] | null; path?: [number, number, number][] }) {
  const { field, u, animate, scrub } = useSurvey();
  const mesh = useRef<Mesh>(null);
  const st = useRef({ x: 0, z: 0, y: 0, s: 0, init: false, speed: 0 });
  const tmp = useMemo(() => ({ axis: new Vector3(), q: new Quaternion() }), []);
  const wob = useMemo(() => ({ uTime: { value: 0 }, uWobble: { value: 0.012 } }), []);

  const geometry = useMemo(() => new IcosahedronGeometry(R, 24), []);
  const material = useMemo(() => {
    const m = new MeshPhysicalMaterial({
      color: new Color("#eef2f6"),
      metalness: 1,
      roughness: 0.06,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      envMapIntensity: 1.8,
    });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = wob.uTime;
      shader.uniforms.uWobble = wob.uWobble;
      shader.vertexShader = WOBBLE_HEAD + shader.vertexShader.replace("#include <begin_vertex>", WOBBLE_BEGIN);
    };
    return m;
  }, [wob]);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((state, dt) => {
    const m = mesh.current;
    if (!m) return;
    const d = Math.min(dt, 1 / 20);
    const s = st.current;
    wob.uTime.value = state.clock.getElapsedTime();
    if (target && !s.init) {
      s.x = target[0];
      s.z = target[2];
      s.init = true;
    }
    const beadT = scrub?.current?.beadT ?? null;
    const driven = beadT != null && !!path && path.length > 0;
    if (driven && !s.init) {
      const [x0, z0] = climbPointXZ(path, beadT);
      s.x = x0;
      s.z = z0;
      s.init = true;
    }
    if (target || driven) {
      const px = s.x;
      const pz = s.z;
      if (driven) {
        [s.x, s.z] = climbPointXZ(path, beadT);
      } else if (target) {
        const lam = animate ? 2.1 : 1e3;
        s.x = damp(s.x, target[0], lam, d);
        s.z = damp(s.z, target[2], lam, d);
      }
      const dx = s.x - px;
      const dz = s.z - pz;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-6) {
        tmp.axis.set(dz, 0, -dx).normalize();
        tmp.q.setFromAxisAngle(tmp.axis, dist / R);
        m.quaternion.premultiply(tmp.q);
      }
      s.speed = damp(s.speed, dist / Math.max(d, 1e-4), 6, d);
    }
    s.s = damp(s.s, target || driven ? 1 : 0, animate ? 3 : 1e3, d);
    const ground = field.sample(s.x, s.z);
    s.y = ground + R * 0.82;
    m.position.set(s.x, s.y, s.z);
    m.scale.setScalar(Math.max(1e-3, s.s));
    m.visible = s.s > 0.01;
    wob.uWobble.value = animate ? 0.01 + Math.min(0.03, s.speed * 0.012) : 0;
    u.uBead.value.set(s.x, s.y, s.z, m.visible ? R * s.s : -1);
  });

  return <mesh ref={mesh} geometry={geometry} material={material} />;
}, sameProps);

/** The climb path: a dashed amber survey line over the ground through every keep, in order. */
export const ClimbPath = memo(function ClimbPath({ climb, fieldKey }: { climb: [number, number, number][]; fieldKey: string }) {
  const { field } = useSurvey();
  const points = useMemo(() => {
    void fieldKey; // recompute when the ground changes
    // Stay mounted with a stub when there is no path yet: unmounting disposes the dashed-line program and it would
    // recompile (a visible hitch) the moment the first keep lands.
    if (climb.length < 2) return [[0, -50, 0], [0, -50.01, 0]] as [number, number, number][];
    const out: [number, number, number][] = [];
    for (let i = 0; i < climb.length - 1; i++) {
      const a = climb[i];
      const b = climb[i + 1];
      const n = Math.max(6, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.12));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const t = k / n;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[2] + (b[2] - a[2]) * t;
        out.push([x, field.sampleTarget(x, z) + 0.05, z]);
      }
    }
    return out;
  }, [climb, field, fieldKey]);
  return <Line visible={climb.length >= 2} points={points} color={PATH_COLOR} lineWidth={1.4} dashed dashSize={0.16} gapSize={0.11} transparent opacity={0.9} toneMapped={false} />;
}, sameProps);
