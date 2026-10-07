"use client";

import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import { Color, IcosahedronGeometry, Mesh, MeshPhysicalMaterial, Quaternion, Vector3 } from "three";
import { climbPointXZ } from "@/lib/survey/poses";
import { WOBBLE_BEGIN, WOBBLE_HEAD } from "./shaders";
import { damp, MAX_PATH, sameProps, useSurvey } from "./shared";

const R = 0.34;

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
    const beadT = scrub?.current?.beadT ?? null;
    const driven = beadT != null && !!path && path.length > 0;
    if (driven && !s.init) {
      const [x0, z0] = climbPointXZ(path, beadT);
      s.x = x0;
      s.z = z0;
      s.init = true;
    }
    if (target && !s.init) {
      s.x = target[0];
      s.z = target[2];
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
    } else s.speed = damp(s.speed, 0, 6, d);
    s.s = damp(s.s, target || driven ? 1 : 0, animate ? 3 : 1e3, d);
    const ground = field.sample(s.x, s.z);
    // Sits slightly into the ground (a heavy drop of mercury flattens where it touches), lifting a hair while it rolls.
    s.y = ground + R * (0.8 + Math.min(0.04, s.speed * 0.01));
    m.position.set(s.x, s.y, s.z);
    m.scale.setScalar(Math.max(1e-3, s.s));
    m.visible = s.s > 0.01;
    // Surface tension: a slow idle shimmer that quickens (and deepens a little) while it rolls.
    wob.uWobble.value = animate ? 0.008 + Math.min(0.022, s.speed * 0.01) : 0;
    u.uBead.value.set(s.x, s.y, s.z, m.visible ? R * s.s : -1);
  });

  return <mesh ref={mesh} geometry={geometry} material={material} />;
}, sameProps);

/**
 * The climb path: a dashed amber survey line through every keep, in order. It is painted onto the ground by the
 * terrain shader (uPath), so it hugs every slope — never sinking into a ridge or floating over a hollow — with dashes
 * evenly spaced in world units. Beyond the bead (landing) the path ahead is dimmer: the route it is about to take.
 */
export const ClimbPath = memo(function ClimbPath({ climb }: { climb: [number, number, number][] }) {
  const { u, scrub } = useSurvey();
  const cum = useMemo(() => {
    const n = Math.min(climb.length, MAX_PATH);
    const out = new Float32Array(Math.max(1, n));
    for (let i = 1; i < n; i++) out[i] = out[i - 1] + Math.hypot(climb[i][0] - climb[i - 1][0], climb[i][2] - climb[i - 1][2]);
    return out;
  }, [climb]);
  useEffect(() => {
    const n = Math.min(climb.length, MAX_PATH);
    for (let i = 0; i < n; i++) u.uPath.value[i].set(climb[i][0], climb[i][2], cum[i]);
    u.uPathN.value = n;
    return () => {
      u.uPathN.value = 0;
    };
  }, [climb, cum, u]);
  const op = useRef(0);
  useFrame((_, dt) => {
    op.current = damp(op.current, climb.length >= 2 ? 1 : 0, 3, Math.min(dt, 0.05));
    const t = scrub?.current?.beadT;
    let head = 1e6;
    if (t != null && climb.length >= 2) {
      const n = Math.min(climb.length, MAX_PATH);
      const c = Math.min(n - 1, Math.max(0, t));
      const i = Math.min(n - 2, Math.floor(c));
      head = cum[i] + (cum[i + 1] - cum[i]) * (c - i);
    }
    u.uPathSpec.value.set(head, op.current);
  });
  return null;
}, sameProps);
