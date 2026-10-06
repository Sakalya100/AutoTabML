"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: three.js objects and camera state are mutated imperatively
   inside useFrame (outside React render); refs seed initial transforms only. */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { PerspectiveCamera, Vector3 } from "three";
import type { RunView } from "@/lib/run-state";
import type { ReefLayout, SceneChapter } from "@/lib/scene/contract";
import { CROWN_Y } from "@/lib/scene/layout";
import type { ColumnKind } from "@/lib/schema";
import { Halo, SelectionRing, Shell } from "./artifacts";
import { CrashBurst } from "./crash";
import { Backdrop, GodRays, MarineSnow, Nutrients, Seabed, Surface } from "./environment";
import { damp, makeUniforms, now, ReefContext, springStep, type ReefCtx } from "./shared";
import { ReefTree } from "./tree";

export interface NodeInfo {
  title: string;
  status: string;
  score: string;
}

export interface WorldLabels {
  sealed?: string;
  select?: string;
  test?: string;
  gap?: string;
  ceiling?: string;
}

export interface ReefWorldProps {
  layout: ReefLayout;
  /** Layout of the complete run (replays): frames the camera for the final reef so it doesn't creep outward. */
  frameLayout?: ReefLayout | null;
  phase: RunView["phase"];
  columnKinds: ColumnKind[];
  currentId: string | null;
  chapter?: SceneChapter;
  lite?: boolean;
  /** false → static, fully grown state (reduced motion). */
  animate?: boolean;
  interactive?: boolean;
  /** Drag to orbit. Thumbnails and the landing hero drive the camera themselves. */
  controls?: boolean;
  autoRotate?: boolean;
  selectedId?: string | null;
  /** The experiment the camera should ease toward (a user pick, not playback follow). */
  focusId?: string | null;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
  /** DOM overlay whose `[data-label=<LabelKey>]` children the scene positions every frame. */
  labelRoot?: HTMLElement | null;
}

export type LabelKey = "ceiling" | "sealed" | "select" | "gap" | "test" | "tooltip";

interface Bounds {
  center: [number, number, number];
  top: number;
  halfW: number;
  shell: [number, number, number];
}

function boundsOf(layout: ReefLayout): Bounds {
  let minX = -1, maxX = 1, minZ = -1, maxZ = 1, maxY = 2;
  for (const n of layout.nodes) {
    minX = Math.min(minX, n.tip[0]);
    maxX = Math.max(maxX, n.tip[0]);
    minZ = Math.min(minZ, n.tip[2]);
    maxZ = Math.max(maxZ, n.tip[2]);
    maxY = Math.max(maxY, n.tip[1]);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const top = Math.max(maxY, layout.surfaceY ?? 0, layout.testY ?? 0) + 0.4;
  const shell: [number, number, number] = [maxX + 1.7, 0, cz + Math.max(1.2, (maxZ - minZ) * 0.35)];
  const halfW = Math.max(maxX - minX, maxZ - minZ, shell[0] - minX) / 2 + 1.2;
  return { center: [cx, top / 2 - 0.6, cz], top, halfW, shell };
}

/** Coarsen bounds so a live run's camera/environment targets only move in deliberate steps (hysteresis). */
function useStableBounds(b: Bounds): Bounds {
  const [stable, setStable] = useState(b);
  const moved =
    Math.abs(stable.top - b.top) > 0.35 ||
    Math.abs(stable.halfW - b.halfW) > 0.35 ||
    Math.hypot(stable.center[0] - b.center[0], stable.center[2] - b.center[2]) > 0.3 ||
    Math.hypot(stable.shell[0] - b.shell[0], stable.shell[2] - b.shell[2]) > 0.3;
  if (moved) setStable(b); // derived state: React re-renders immediately with the new value
  return moved ? b : stable;
}

export function ReefWorld({
  layout,
  frameLayout = null,
  phase,
  columnKinds,
  currentId,
  chapter = "overview",
  lite = false,
  animate = true,
  interactive = false,
  controls = false,
  autoRotate = false,
  selectedId = null,
  focusId = null,
  onSelect,
  onHover,
  labelRoot,
}: ReefWorldProps) {
  const [mountedAt] = useState(now);
  const ctx = useMemo<ReefCtx>(() => ({ u: makeUniforms(), animate, lite, mountedAt }), [animate, lite, mountedAt]);
  useFrame((s) => {
    ctx.u.uTime.value = animate ? s.clock.elapsedTime + 20 : 26;
  });

  // Crashes present on first mount don't replay their burst.
  const [initial] = useState(() => new Set(layout.nodes.map((n) => n.id)));
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    onHover?.(hovered);
  }, [hovered, onHover]);
  useEffect(() => {
    if (!interactive) return;
    document.body.style.cursor = hovered ? "pointer" : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hovered, interactive]);

  const b = useStableBounds(useMemo(() => boundsOf(frameLayout ?? layout), [frameLayout, layout]));
  // Reduced motion renders on demand: redraw when anything the frame depends on changes.
  const invalidate = useThree((st) => st.invalidate);
  useEffect(() => {
    invalidate();
  }, [invalidate, chapter, focusId, selectedId, hovered, layout, phase]);
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const best = layout.bestId ? byId.get(layout.bestId) : undefined;
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const hoverNode = hovered ? byId.get(hovered) : undefined;
  const root: [number, number, number] = [layout.nodes[0]?.base[0] ?? 0, 0.3, layout.nodes[0]?.base[2] ?? 0];

  // "The first seconds of any run": the data profile drifts in, then the streams fade.
  const [early, setEarly] = useState(phase !== "finished");
  useEffect(() => {
    const t = setTimeout(() => setEarly(false), 7000);
    return () => clearTimeout(t);
  }, []);
  const nutrientsOn = chapter === "intro" || chapter === "nutrients" || (phase === "running" && layout.nodes.length <= 1) || early;
  const rayTop = Math.max(b.top, CROWN_Y + 4) + 6;

  return (
    <ReefContext.Provider value={ctx}>
      <Backdrop />
      <GodRays center={b.center} top={rayTop} />
      <Seabed />
      <Surface surfaceY={layout.surfaceY} hiddenY={Math.max(b.top, CROWN_Y) + 6.5} center={b.center} />
      <MarineSnow center={b.center} />
      <Nutrients kinds={columnKinds} active={nutrientsOn} root={root} />

      <ReefTree layout={layout} hoveredId={hovered} selectedId={selectedId} interactive={interactive} onHover={setHovered} onSelect={onSelect} />
      {animate &&
        layout.nodes.filter((n) => n.status === "crash" && !initial.has(n.id)).map((n) => <CrashBurst key={n.id} id={n.id} at={n.tip} />)}

      {best && best.status === "keep" && <Halo position={best.tip} radius={layout.haloRadius} />}
      {interactive && selected && <SelectionRing position={selected.tip} />}

      <Shell position={b.shell} open={phase === "finished"} selectY={layout.selectY} testY={layout.testY} />

      {labelRoot && (
        <Projector
          root={labelRoot}
          anchors={{
            ceiling: layout.surfaceY != null ? [b.center[0] - b.halfW * 0.95, layout.surfaceY - 0.2, b.center[2] + 1] : null,
            sealed: [b.shell[0] - 0.7, b.shell[1] + 0.25, b.shell[2]],
            select: layout.selectY != null ? [b.shell[0] - 0.36, layout.selectY, b.shell[2]] : null,
            gap: layout.selectY != null && layout.testY != null ? [b.shell[0] - 0.36, (layout.selectY + layout.testY) / 2, b.shell[2]] : null,
            test: layout.testY != null ? [b.shell[0] + 0.38, layout.testY, b.shell[2]] : null,
            tooltip: hoverNode ? hoverNode.tip : null,
          }}
        />
      )}

      <CameraRig
        chapter={chapter}
        bounds={b}
        layout={layout}
        frameLayout={frameLayout}
        currentId={currentId}
        focusId={focusId}
        controls={controls}
        autoRotate={autoRotate && animate}
        animate={animate}
      />
    </ReefContext.Provider>
  );
}

/**
 * Projects 3D anchors to screen and moves the caller's DOM labels — no React re-renders. Positions are smoothed and
 * labels fade (instead of popping) when their anchor appears, disappears, goes behind the camera or off screen.
 */
function Projector({ root, anchors }: { root: HTMLElement; anchors: Record<LabelKey, [number, number, number] | null> }) {
  const v = useMemo(() => new Vector3(), []);
  const st = useMemo(() => new WeakMap<HTMLElement, { x: number; y: number; o: number }>(), []);
  useFrame(({ camera, size }, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    for (const el of root.querySelectorAll<HTMLElement>("[data-label]")) {
      const p = anchors[el.dataset.label as LabelKey];
      let s = st.get(el);
      let x = s?.x ?? 0, y = s?.y ?? 0, show = false;
      if (p) {
        v.set(p[0], p[1], p[2]).project(camera);
        x = ((v.x + 1) / 2) * size.width;
        y = ((1 - v.y) / 2) * size.height;
        const m = 24;
        show = v.z < 1 && x > -m && x < size.width + m && y > -m && y < size.height + m;
      }
      if (!s) {
        s = { x, y, o: 0 };
        st.set(el, s);
      }
      if (s.o < 0.03) {
        s.x = x;
        s.y = y;
      } else {
        s.x = damp(s.x, x, 16, dt);
        s.y = damp(s.y, y, 16, dt);
      }
      s.o = damp(s.o, show ? 1 : 0, show ? 7 : 12, dt);
      el.style.visibility = s.o < 0.01 ? "hidden" : "";
      el.style.opacity = s.o.toFixed(3);
      el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`;
    }
  });
  return null;
}

const OVERVIEW_AZ = Math.atan2(0.62, 1);

/** Points the camera must keep in frame: every branch end, the shell, and the surface/pearl once they exist. */
function fitPoints(layout: ReefLayout, bounds: Bounds, withShell = true): Vector3[] {
  const pts: Vector3[] = [new Vector3(bounds.center[0], 0, bounds.center[2])];
  for (const n of layout.nodes) pts.push(new Vector3(...n.tip), new Vector3(...n.base));
  const [sx, , sz] = bounds.shell;
  if (withShell) pts.push(new Vector3(sx, 0, sz), new Vector3(sx, 0.6, sz));
  if (withShell && layout.testY != null) pts.push(new Vector3(sx, layout.testY + 0.3, sz));
  if (layout.surfaceY != null) pts.push(new Vector3(bounds.center[0], layout.surfaceY + 0.2, bounds.center[2]));
  return pts;
}

const dirAt = (az: number, elev: number) => new Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev));

/**
 * Distance along `dir` (target → camera) at which every point fits: its vertical extent fills at most `fillV` of the
 * frame height and its horizontal extent `fillH` of the width. Exact for a perspective camera looking at `target`.
 */
function fitDistance(pts: Vector3[], target: Vector3, dir: Vector3, tanV: number, aspect: number, fillV: number, fillH: number): number {
  const z = dir.clone().normalize();
  const x = new Vector3(0, 1, 0).cross(z).normalize();
  const y = z.clone().cross(x);
  const o = new Vector3();
  let d = 3;
  for (const p of pts) {
    o.subVectors(p, target);
    const zc = o.dot(z);
    d = Math.max(d, zc + Math.abs(o.dot(y)) / (tanV * fillV), zc + Math.abs(o.dot(x)) / (tanV * aspect * fillH));
  }
  return d;
}

/** Rotation-invariant fit: the worst case over azimuths, so an orbiting camera never breathes in and out. */
function fitAround(pts: Vector3[], target: Vector3, elev: number, tanV: number, aspect: number, fillV: number, fillH: number): number {
  let d = 0;
  for (let i = 0; i < 12; i++) d = Math.max(d, fitDistance(pts, target, dirAt((i / 12) * Math.PI * 2, elev), tanV, aspect, fillV, fillH));
  return d;
}

function centerOf(pts: Vector3[]): Vector3 {
  const lo = new Vector3(Infinity, Infinity, Infinity);
  const hi = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of pts) {
    lo.min(p);
    hi.max(p);
  }
  return lo.add(hi).multiplyScalar(0.5);
}

interface CamGoal {
  target: Vector3;
  dist: number;
  elev: number;
}

/**
 * The camera is (target, distance, elevation, azimuth). The first three follow critically damped springs toward a
 * goal computed only when the layout/chapter changes (never per frame), with hysteresis on the distance so a growing
 * reef doesn't make it pump. Azimuth belongs to the user (drag, with inertia) or a slow auto-rotate — the rig never
 * pulls it back.
 */
function CameraRig({
  chapter,
  bounds,
  layout,
  frameLayout,
  currentId,
  focusId,
  controls,
  autoRotate,
  animate,
}: {
  chapter: SceneChapter;
  bounds: Bounds;
  layout: ReefLayout;
  /** The complete run (replays): framing it once means the camera never pumps while the reef grows into it. */
  frameLayout: ReefLayout | null;
  currentId: string | null;
  focusId: string | null;
  controls: boolean;
  autoRotate: boolean;
  animate: boolean;
}) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const aspect = size.width / Math.max(1, size.height);
  const tanV = Math.tan((((camera.fov ?? 38) / 2) * Math.PI) / 180);

  // Wide hero layouts carry text on the left: shift the intro reef toward the right via a view offset.
  useEffect(() => {
    if (!camera.isPerspectiveCamera) return;
    if (chapter === "intro")
      camera.setViewOffset(size.width, size.height, aspect > 1.25 ? -size.width * 0.24 : 0, -size.height * (aspect < 0.75 ? 0.1 : 0.2), size.width, size.height);
    else camera.clearViewOffset();
    return () => camera.clearViewOffset();
  }, [camera, chapter, aspect, size.width, size.height]);

  const tipOf = (id: string | null | undefined) => {
    const n = (id ? layout.nodes.find((m) => m.id === id) : undefined) ?? layout.nodes.at(-1);
    return n ? new Vector3(...n.tip) : new Vector3(...bounds.center);
  };
  const mutationTarget = chapter === "mutation" ? (currentId ?? layout.nodes.at(-1)?.id ?? null) : null;

  const rawGoal = useMemo<CamGoal>(() => {
    const pts = fitPoints(frameLayout ?? layout, bounds, chapter !== "intro");
    switch (chapter) {
      case "mutation":
      case "selection":
        return { target: tipOf(chapter === "mutation" ? mutationTarget : layout.bestId), dist: 6, elev: 0.12 };
      case "test":
        return { target: new Vector3(bounds.shell[0], (layout.testY ?? 1.5) * 0.5 + 0.4, bounds.shell[2]), dist: Math.max(6, (layout.testY ?? 2) * 1.6 + 3), elev: 0.2 };
      case "nutrients": {
        const target = new Vector3(bounds.center[0], 1.4, bounds.center[2]);
        return { target, dist: fitAround(pts, target, 0.12, tanV, aspect, 0.8, 0.9) * 1.15, elev: 0.12 };
      }
      case "ceiling": {
        const y = layout.surfaceY ?? bounds.top;
        const target = new Vector3(bounds.center[0], y - 0.6, bounds.center[2]);
        return { target, dist: fitAround(pts, target, -0.42, tanV, aspect, 1.6, 0.9) * 0.75, elev: -0.42 };
      }
      default: {
        const intro = chapter === "intro";
        const elev = intro ? -0.08 : 0.2;
        const target = centerOf(pts);
        const f = focusId ? layout.nodes.find((n) => n.id === focusId) : undefined;
        if (f && !intro) target.lerp(new Vector3(...f.tip), 0.55);
        const fillH = intro && aspect < 0.75 ? 1.8 : 0.86;
        const d = fitAround(pts, target, elev, tanV, aspect, intro ? (aspect < 0.75 ? 0.55 : 0.46) : 0.72, fillH);
        return { target, dist: f && !intro ? d * 0.72 : d, elev };
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tipOf reads layout/bounds
  }, [layout, frameLayout, bounds, chapter, focusId, mutationTarget, tanV, aspect]);

  // Hysteresis: within a chapter, ignore small changes so incremental growth doesn't make the camera pump.
  const [held, setHeld] = useState<{ chapter: SceneChapter; focus: string | null; g: CamGoal }>({ chapter, focus: focusId, g: rawGoal });
  const sameShot = held.chapter === chapter && held.focus === focusId;
  const significant =
    !sameShot || rawGoal.dist > held.g.dist * 1.02 || rawGoal.dist < held.g.dist * 0.86 || rawGoal.target.distanceTo(held.g.target) > 0.25 || Math.abs(rawGoal.elev - held.g.elev) > 1e-6;
  if (significant && held.g !== rawGoal) setHeld({ chapter, focus: focusId, g: rawGoal });
  const goal = significant ? rawGoal : held.g;

  const ceilY = (layout.surfaceY ?? Math.max(bounds.top, CROWN_Y) + 6.5) - 0.6;
  const st = useRef({
    placed: false,
    az: chapter === "intro" ? -0.7 : OVERVIEW_AZ,
    vAz: 0,
    spin: 0,
    elevUser: 0,
    vEl: 0,
    drag: null as null | { x: number; y: number; t: number },
    lastUser: -Infinity,
    tx: 0, ty: 0, tz: 0, vx: 0, vy: 0, vz: 0,
    d: 10, vd: 0,
    e: 0.2, ve: 0,
    ceil: ceilY,
    chapter,
  });

  // Drag to orbit (with inertia). Owned here, so nothing else ever writes the camera.
  useEffect(() => {
    if (!controls) return;
    const el = gl.domElement;
    const s = st.current;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      s.drag = { x: e.clientX, y: e.clientY, t: performance.now() };
      s.vAz = 0;
      s.vEl = 0;
    };
    const move = (e: PointerEvent) => {
      if (!s.drag) return;
      const t = performance.now();
      const dt = Math.max(1, t - s.drag.t) / 1000;
      const dAz = -(e.clientX - s.drag.x) * 0.0065;
      const dEl = (e.clientY - s.drag.y) * 0.0045;
      s.az += dAz;
      s.elevUser = Math.min(0.75, Math.max(-0.45, s.elevUser + dEl));
      s.vAz = dAz / dt;
      s.vEl = dEl / dt;
      s.drag = { x: e.clientX, y: e.clientY, t };
      s.lastUser = t / 1000;
    };
    const up = () => {
      if (!s.drag) return;
      if (performance.now() - s.drag.t > 80) {
        s.vAz = 0;
        s.vEl = 0;
      }
      s.drag = null;
      s.lastUser = performance.now() / 1000;
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [controls, gl]);

  const look = useMemo(() => new Vector3(), []);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const s = st.current;
    const elevGoal = goal.elev;
    if (s.chapter !== chapter) {
      // A new chapter re-frames: the user's tilt eases back to the chapter's, their heading is kept.
      s.chapter = chapter;
      s.elevUser = 0;
    }
    if (!s.placed) {
      s.tx = goal.target.x;
      s.ty = goal.target.y;
      s.tz = goal.target.z;
      s.d = goal.dist;
      s.e = elevGoal;
      s.ceil = ceilY;
      s.placed = true;
    }
    // Inertia after a flick; a slow auto-rotate that eases in once the user has let go for a while.
    if (!s.drag) {
      s.az += s.vAz * dt;
      s.elevUser = Math.min(0.75, Math.max(-0.45, s.elevUser + s.vEl * dt));
      s.vAz *= Math.exp(-4 * dt);
      s.vEl *= Math.exp(-6 * dt);
    }
    const idle = !s.drag && performance.now() / 1000 - s.lastUser > 3;
    s.spin = damp(s.spin, autoRotate && idle ? 0.07 : 0, 0.8, dt);
    s.az += s.spin * dt;

    const o = { v: 0 };
    const w = animate ? 2.1 : 1e4;
    s.tx = springStep(s.tx, s.vx, goal.target.x, w, dt, o);
    s.vx = o.v;
    s.ty = springStep(s.ty, s.vy, goal.target.y, w, dt, o);
    s.vy = o.v;
    s.tz = springStep(s.tz, s.vz, goal.target.z, w, dt, o);
    s.vz = o.v;
    s.d = springStep(s.d, s.vd, goal.dist, w * 0.9, dt, o);
    s.vd = o.v;
    s.e = springStep(s.e, s.ve, elevGoal, w, dt, o);
    s.ve = o.v;
    s.ceil = animate ? damp(s.ceil, ceilY, 1.5, dt) : ceilY;

    const elev = Math.min(0.95, Math.max(-0.5, s.e + s.elevUser));
    const dir = dirAt(s.az, elev);
    camera.position.set(s.tx + dir.x * s.d, s.ty + dir.y * s.d, s.tz + dir.z * s.d);
    // The camera always stays under water (the surface is only ever seen from below).
    if (camera.position.y > s.ceil) camera.position.y = s.ceil;
    camera.lookAt(look.set(s.tx, s.ty, s.tz));
  });

  return null;
}
