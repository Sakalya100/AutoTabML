"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: three.js materials/objects are mutated
   imperatively inside useFrame (outside React render); refs seed initial transforms only. */

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, CubicBezierCurve3, Color, MeshBasicMaterial, TubeGeometry, Vector3, type Group, type Mesh, type Points } from "three";
import { REEF, type ReefNode } from "@/lib/scene/contract";
import { branchControls, hash01 } from "@/lib/scene/layout";
import { branchFrag, branchVert, burstVert, colorPointFrag, glowFrag, glowVert } from "./shaders";
import { col, damp, mulberry32, now, useReef, useShaderMaterial } from "./shared";

const V = (p: readonly number[]) => new Vector3(p[0], p[1], p[2]);

export function branchCurve(base: readonly number[], tip: readonly number[], seed: number): CubicBezierCurve3 {
  const [a, b, c, d] = branchControls(base, tip, seed);
  return new CubicBezierCurve3(V(a), V(b), V(c), V(d));
}

function forkTubes(base: readonly number[], tip: readonly number[], seed: number, radius: number, lite: boolean) {
  const d = new Vector3(tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]).normalize();
  const side = new Vector3(-d.z, 0, d.x).normalize();
  const t = V(tip);
  return [-1, 1].map((sgn) => {
    const dir = d.clone().multiplyScalar(0.6).addScaledVector(side, sgn * 0.55).add(new Vector3(0, 0.5, 0)).normalize();
    const end = t.clone().addScaledVector(dir, 0.32 + 0.12 * seed);
    const c = branchCurve([t.x, t.y, t.z], [end.x, end.y, end.z], seed);
    return { geo: taperedTube(c, radius, lite ? 8 : 12, lite ? 5 : 6), end: [end.x, end.y, end.z] as [number, number, number] };
  });
}

/** Tapered tube with a per-vertex `aCenter` (the curve point of its ring) so the shader can grow/shrink it. */
function taperedTube(curve: CubicBezierCurve3, radius: number, tubular: number, radial: number): BufferGeometry {
  const g = new TubeGeometry(curve, tubular, 1, radial, false);
  const pos = g.attributes.position as BufferAttribute;
  const centers = new Float32Array(pos.count * 3);
  const p = new Vector3();
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    curve.getPointAt(t, p);
    const r = radius * (1 - 0.68 * Math.pow(t, 0.85)) * (1 + 0.7 * Math.exp(-t * 14));
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      pos.setXYZ(k, p.x + (pos.getX(k) - p.x) * r, p.y + (pos.getY(k) - p.y) * r, p.z + (pos.getZ(k) - p.z) * r);
      centers.set([p.x, p.y, p.z], k * 3);
    }
  }
  pos.needsUpdate = true;
  g.setAttribute("aCenter", new BufferAttribute(centers, 3));
  g.computeBoundingSphere();
  return g;
}

/** Bleached discards keep most of their skeleton: only small burn holes remain. */
const BLEACH_DISSOLVE = 0.13;

const HIT_MAT = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });

export interface BranchStyle {
  color: string;
  tip: string;
  glow: number;
  radius: number;
}

export function styleOf(node: ReefNode, bestId: string | null): BranchStyle {
  if (node.status === "running") return { color: "#7fdcf0", tip: "#e6fbff", glow: 1.1, radius: 0.075 };
  if (node.status === "discard") return { color: "#a9a2dc", tip: "#d4cff5", glow: 0.9, radius: 0.062 };
  if (node.status === "crash") return { color: REEF.crash, tip: REEF.crash, glow: 0.6, radius: 0.03 };
  if (node.id === bestId) return { color: REEF.best, tip: "#fff1cf", glow: 1.25, radius: 0.14 };
  if (node.isBest) return { color: REEF.keep, tip: REEF.best, glow: 1.0, radius: 0.13 };
  return { color: REEF.keep, tip: "#b9fff0", glow: 0.9, radius: 0.11 };
}

interface BranchProps {
  node: ReefNode;
  bestId: string | null;
  /** Seconds to wait before growing (staggered entrance when a whole reef mounts at once). */
  delay: number;
  /** Mounted already decided (skip-to-end, thumbnails): no withering/burst theatre. */
  settled: boolean;
  highlighted: boolean;
  interactive: boolean;
  onHover?: (id: string | null) => void;
  onClick?: (id: string) => void;
}

export function Branch({ node, bestId, delay, settled, highlighted, interactive, onHover, onClick }: BranchProps) {
  const { animate, lite } = useReef();
  const seed = hash01(node.id);
  const style = styleOf(node, bestId);
  const key = `${node.base.join(",")}|${node.tip.join(",")}|${style.radius}|${lite}`;
  const forked = node.radical && node.status !== "keep" && node.status !== "crash";
  const { curve, geo, hit, forks } = useMemo(() => {
    const curve = branchCurve(node.base, node.tip, seed);
    return {
      curve,
      geo: taperedTube(curve, style.radius, lite ? 28 : 44, lite ? 6 : 9),
      // Radical ideas fork at the tip into two small sub-polyps.
      forks: forked ? forkTubes(node.base, node.tip, seed, style.radius * 0.6, lite) : [],
      hit: interactive ? new TubeGeometry(curve, 10, 0.16, 5, false) : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, interactive, forked]);
  useEffect(
    () => () => {
      geo.dispose();
      hit?.dispose();
      for (const f of forks) f.geo.dispose();
    },
    [geo, hit, forks],
  );

  const mat = useShaderMaterial({
    vertexShader: branchVert,
    fragmentShader: branchFrag,
    uniforms: {
      uGrow: { value: animate ? 0 : 1 },
      uSeed: { value: seed },
      uSway: { value: animate ? 0.05 : 0 },
      uColor: { value: col(style.color) },
      uTipColor: { value: col(style.tip) },
      uGlow: { value: style.glow },
      uDissolve: { value: node.status === "discard" && (settled || !animate) ? BLEACH_DISSOLVE : 0 },
      uEmber: { value: 0 },
      uBleach: { value: node.status === "discard" && (settled || !animate) ? 1 : 0 },
      uHighlight: { value: 0 },
      uDim: { value: 1 },
    },
  });

  const anim = useRef({ born: now() + delay, grow: animate ? 0 : 1, vel: 0, dissolve: mat.uniforms.uDissolve.value as number, hl: 0 });
  // A re-scored tip (running sprout → real height) regrows from partway, so the jump reads as growth.
  // Only a new status or a moved base (e.g. a running shoot promoted to a kept stem) regrows; a pure height
  // change (the live scale widening) just swaps geometry in place.
  const growKey = `${node.status}|${node.base.join(",")}`;
  const lastKey = useRef(growKey);
  useEffect(() => {
    if (lastKey.current !== growKey && animate) anim.current.grow = Math.min(anim.current.grow, 0.35);
    lastKey.current = growKey;
  }, [growKey, animate]);

  const target = useMemo(() => ({ color: new Color(style.color), tip: new Color(style.tip), glow: style.glow }), [style.color, style.tip, style.glow]);

  useFrame((_, rawDt) => {
    const a = anim.current;
    const u = mat.uniforms;
    const dt = Math.min(rawDt, 0.1);
    if (!animate) {
      u.uGrow.value = 1;
      u.uHighlight.value = highlighted ? 0.7 : 0;
      (u.uColor.value as Color).copy(target.color);
      (u.uTipColor.value as Color).copy(target.tip);
      u.uGlow.value = target.glow;
      return;
    }
    if (now() >= a.born) {
      // Under-damped spring toward 1 → ease-out with a soft settle; clamped so the tube never overshoots.
      const k = 26;
      const c = 7.5;
      a.vel += ((1 - a.grow) * k - a.vel * c) * dt;
      a.grow = Math.min(1, a.grow + a.vel * dt);
    }
    // Withering: the branch flares, burns at the edges (ember) and sheds motes, then settles as bleached coral.
    if (node.status === "discard" && a.grow > 0.92) {
      a.dissolve = damp(a.dissolve, BLEACH_DISSOLVE, 0.9, dt);
      u.uBleach.value = damp(u.uBleach.value as number, 1, 0.7, dt);
    }
    u.uEmber.value = node.status === "discard" && !settled ? Math.max(0, 1 - (u.uBleach.value as number)) * Math.min(1, a.dissolve * 12) : 0;
    a.hl = damp(a.hl, highlighted ? 1 : 0, 10, dt);
    u.uGrow.value = a.grow;
    u.uDissolve.value = a.dissolve;
    u.uHighlight.value = a.hl * 0.7;
    (u.uColor.value as Color).lerp(target.color, 1 - Math.exp(-3 * dt));
    (u.uTipColor.value as Color).lerp(target.tip, 1 - Math.exp(-3 * dt));
    u.uGlow.value = damp(u.uGlow.value as number, target.glow, 3, dt);
  });

  if (node.status === "crash") return <CrashSpark node={node} settled={settled} interactive={interactive} onHover={onHover} onClick={onClick} />;

  const handlers = interactive
    ? {
        onPointerOver: (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover?.(node.id);
        },
        onPointerOut: () => onHover?.(null),
        onClick: (e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onClick?.(node.id);
        },
      }
    : {};

  return (
    <group>
      <mesh geometry={geo} material={mat} frustumCulled={false} />
      {forks.map((f, i) => (
        <mesh key={i} geometry={f.geo} material={mat} frustumCulled={false} />
      ))}
      {hit && <mesh geometry={hit} material={HIT_MAT} {...handlers} />}
      {(node.status === "keep" || node.status === "running") && <TipBulb node={node} style={style} grow={anim} />}
      {node.status === "discard" && !settled && animate && <Shed curve={curve} />}
    </group>
  );
}

/** A glowing polyp at kept tips; a pulsing bud on the experiment that is running. */
function TipBulb({ node, style, grow }: { node: ReefNode; style: BranchStyle; grow: React.RefObject<{ grow: number }> }) {
  const { animate } = useReef();
  const ref = useRef<Group>(null);
  const running = node.status === "running";
  const mat = useShaderMaterial(
    {
      vertexShader: glowVert,
      fragmentShader: glowFrag,
      additive: true,
      uniforms: { uColor: { value: col(style.tip) }, uIntensity: { value: 1 }, uCore: { value: 1.2 }, uPower: { value: 1.6 } },
    },
    style.tip,
  );
  const base = style.radius * (running ? 2.2 : 2.0);
  useFrame((s) => {
    if (!ref.current) return;
    const g = grow.current?.grow ?? 1;
    const vis = Math.max(0, (g - 0.9) / 0.1);
    const t = s.clock.elapsedTime;
    const pulse = animate ? (running ? 1 + 0.35 * Math.sin(t * 5) : 1 + 0.08 * Math.sin(t * 1.6 + node.index)) : 1;
    ref.current.scale.setScalar(Math.max(0.0001, vis * pulse));
  });
  return (
    <group ref={ref} position={node.tip}>
      <mesh material={mat} renderOrder={6}>
        <sphereGeometry args={[base, 18, 14]} />
      </mesh>
    </group>
  );
}

/** Motes shed by a withering branch: sampled along its curve, drifting up and away. */
function Shed({ curve }: { curve: CubicBezierCurve3 }) {
  const ref = useRef<Points>(null);
  const born = useRef(now());
  const geo = useMemo(() => {
    const n = 30;
    const r = mulberry32(Math.floor(curve.getLength() * 1000));
    const pos = new Float32Array(n * 3);
    const dir = new Float32Array(n * 3);
    const rnd = new Float32Array(n * 2);
    const p = new Vector3();
    for (let i = 0; i < n; i++) {
      curve.getPointAt(0.25 + 0.75 * r(), p);
      pos.set([p.x, p.y, p.z], i * 3);
      dir.set([r() - 0.5, r() * 0.4, r() - 0.5], i * 3);
      rnd.set([r(), r()], i * 2);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("aDir", new BufferAttribute(dir, 3));
    g.setAttribute("aRnd", new BufferAttribute(rnd, 2));
    return g;
  }, [curve]);
  useEffect(() => () => geo.dispose(), [geo]);
  const mat = useShaderMaterial({
    vertexShader: burstVert,
    fragmentShader: colorPointFrag,
    additive: true,
    uniforms: {
      uAge: { value: 0 },
      uLife: { value: 4.5 },
      uSpeed: { value: 0.9 },
      uRise: { value: 0.25 },
      uPixel: { value: 3.0 },
      uColorA: { value: col("#b7b0ff") },
      uColorB: { value: col("#2a2546") },
    },
  });
  useFrame(() => {
    const age = now() - born.current - 0.5;
    mat.uniforms.uAge.value = age;
    if (ref.current) ref.current.visible = age < 4.6;
  });
  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} renderOrder={7} />;
}

/** Crash: a brief burst of red sparks, then a dim ember (no branch). */
function CrashSpark({
  node,
  settled,
  interactive,
  onHover,
  onClick,
}: {
  node: ReefNode;
  settled: boolean;
  interactive: boolean;
  onHover?: (id: string | null) => void;
  onClick?: (id: string) => void;
}) {
  const { animate } = useReef();
  const ref = useRef<Points>(null);
  const ember = useRef<Mesh>(null);
  const born = useRef(now());
  const geo = useMemo(() => {
    const n = 48;
    const r = mulberry32(Math.floor(hash01(node.id) * 1e6));
    const pos = new Float32Array(n * 3);
    const dir = new Float32Array(n * 3);
    const rnd = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      pos.set(node.tip, i * 3);
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
  }, [node.id, node.tip]);
  useEffect(() => () => geo.dispose(), [geo]);
  const mat = useShaderMaterial({
    vertexShader: burstVert,
    fragmentShader: colorPointFrag,
    additive: true,
    uniforms: {
      uAge: { value: 0 },
      uLife: { value: 1.6 },
      uSpeed: { value: 2.6 },
      uRise: { value: -0.4 },
      uPixel: { value: 4.0 },
      uColorA: { value: col("#ffd2a0") },
      uColorB: { value: col(REEF.crash) },
    },
  });
  const emberMat = useShaderMaterial({
    vertexShader: glowVert,
    fragmentShader: glowFrag,
    additive: true,
    uniforms: { uColor: { value: col(REEF.crash) }, uIntensity: { value: 0.8 }, uCore: { value: 1 }, uPower: { value: 1.5 } },
  });
  const showBurst = animate && !settled;
  useFrame((s) => {
    const age = now() - born.current;
    mat.uniforms.uAge.value = age;
    if (ref.current) ref.current.visible = showBurst && age < 1.7;
    emberMat.uniforms.uIntensity.value = animate ? 0.55 + 0.25 * Math.sin(s.clock.elapsedTime * 3 + node.index) : 0.7;
    if (ember.current) ember.current.scale.setScalar(1);
  });
  return (
    <group>
      {showBurst && <points ref={ref} geometry={geo} material={mat} frustumCulled={false} renderOrder={7} />}
      <mesh
        ref={ember}
        position={node.tip}
        material={emberMat}
        renderOrder={6}
        {...(interactive
          ? {
              onPointerOver: (e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation();
                onHover?.(node.id);
              },
              onPointerOut: () => onHover?.(null),
              onClick: (e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                onClick?.(node.id);
              },
            }
          : {})}
      >
        <icosahedronGeometry args={[0.09, 1]} />
      </mesh>
    </group>
  );
}
