"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: three.js materials/objects are mutated
   imperatively inside useFrame (outside React render); refs seed initial transforms only. */

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { PerspectiveCamera, Vector3 } from "three";
import type { RunView } from "@/lib/run-state";
import type { ReefLayout, SceneChapter } from "@/lib/scene/contract";
import { CROWN_Y } from "@/lib/scene/layout";
import type { ColumnKind } from "@/lib/schema";
import { Halo, SelectionRing, Shell } from "./artifacts";
import { Branch } from "./branch";
import { Backdrop, GodRays, MarineSnow, Nutrients, Seabed, Surface } from "./environment";
import { damp, makeUniforms, now, ReefContext, type ReefCtx } from "./shared";

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
  /** OrbitControls (drag to orbit). Thumbnails and the landing hero drive the camera themselves. */
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
  // Aim a little below the middle: the seabed, shell and labels need room above the panel's legend.
  return { center: [cx, top / 2 - 0.6, cz], top, halfW, shell };
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

  // Nodes present on first mount grow in a quick stagger; later ones grow as they arrive.
  const [initial] = useState(() => new Set(layout.nodes.filter((n) => n.status !== "running").map((n) => n.id)));
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

  const b = useMemo(() => boundsOf(frameLayout ?? layout), [frameLayout, layout]);
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

  return (
    <ReefContext.Provider value={ctx}>
      <Backdrop />
      <GodRays center={b.center} top={Math.max(b.top, CROWN_Y + 4) + 6} />
      <Seabed />
      <Surface surfaceY={layout.surfaceY} hiddenY={Math.max(b.top, CROWN_Y) + 6.5} center={b.center} />
      <MarineSnow center={b.center} />
      <Nutrients kinds={columnKinds} active={nutrientsOn} root={root} />

      {layout.nodes.map((n) => (
        <Branch
          key={n.id}
          node={n}
          bestId={layout.bestId}
          delay={initial.has(n.id) ? Math.min(2.4, n.index * 0.065) : 0}
          settled={initial.has(n.id)}
          highlighted={n.id === hovered || n.id === selectedId}
          interactive={interactive}
          onHover={setHovered}
          onClick={onSelect}
        />
      ))}

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
        currentId={currentId}
        focusId={focusId}
        controls={controls}
        autoRotate={autoRotate && animate}
        animate={animate}
      />
    </ReefContext.Provider>
  );
}

/** Projects 3D anchors to screen and moves the caller's DOM labels — no extra React roots, no re-renders. */
function Projector({ root, anchors }: { root: HTMLElement; anchors: Record<LabelKey, [number, number, number] | null> }) {
  const v = useMemo(() => new Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-label]")) {
      const p = anchors[el.dataset.label as LabelKey];
      if (!p) {
        el.style.visibility = "hidden";
        continue;
      }
      v.set(p[0], p[1], p[2]).project(camera);
      const behind = v.z > 1;
      el.style.visibility = behind ? "hidden" : "";
      el.style.transform = `translate3d(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px, 0)`;
    }
  });
  return null;
}

const OVERVIEW_DIR = new Vector3(0.62, 0.2, 1).normalize();

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

function centerOf(pts: Vector3[]): Vector3 {
  const lo = new Vector3(Infinity, Infinity, Infinity);
  const hi = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of pts) {
    lo.min(p);
    hi.max(p);
  }
  return lo.add(hi).multiplyScalar(0.5);
}

/** Seconds of quiet after a user drag before auto-framing resumes. */
const USER_HOLD_S = 3.5;

function CameraRig({
  chapter,
  bounds,
  layout,
  currentId,
  focusId,
  controls,
  autoRotate,
  animate,
}: {
  chapter: SceneChapter;
  bounds: Bounds;
  layout: ReefLayout;
  currentId: string | null;
  focusId: string | null;
  controls: boolean;
  autoRotate: boolean;
  animate: boolean;
}) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const ctrl = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const look = useRef(new Vector3(...bounds.center));
  const azimuth = useRef(0);
  const user = useRef({ dragging: false, last: -Infinity });

  const tanV = Math.tan((((camera.fov ?? 38) / 2) * Math.PI) / 180);
  // The hero (intro) frames the reef alone; the shell may sit off to the side.
  const pts = useMemo(() => fitPoints(layout, bounds, chapter !== "intro"), [layout, bounds, chapter]);
  const ceilY = (layout.surfaceY ?? Math.max(bounds.top, CROWN_Y) + 6.5) - 0.6;

  // Wide hero layouts carry text on the left: shift the intro reef toward the right via a view offset.
  useEffect(() => {
    if (!camera.isPerspectiveCamera) return;
    // Hero canvases bleed above the fold, so the intro reef sits low in its frame (negative offsetY moves content down).
    if (chapter === "intro")
      camera.setViewOffset(size.width, size.height, aspect > 1.25 ? -size.width * 0.24 : 0, -size.height * (aspect < 0.75 ? 0.1 : 0.2), size.width, size.height);
    else camera.clearViewOffset();
    return () => camera.clearViewOffset();
  }, [camera, chapter, aspect, size.width, size.height]);

  // Close-up chapters aim at one thing; overview/intro/ceiling auto-fit the whole current reef.
  const tipOf = (id: string | null | undefined) => {
    const n = (id ? layout.nodes.find((m) => m.id === id) : undefined) ?? layout.nodes.at(-1);
    return n ? new Vector3(...n.tip) : new Vector3(...bounds.center);
  };

  const placed = useRef(false);
  const goalPos = useRef(new Vector3());
  const goalTarget = useRef(new Vector3());
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const u = user.current;
    const held = u.dragging || performance.now() / 1000 - u.last < USER_HOLD_S;
    if (held && placed.current) return;

    // Keep the camera's current azimuth (user orbit / autoRotate); chapters set the elevation.
    const cur = camera.position.clone().sub(look.current);
    // Intro starts from the other side so the shell sits behind the reef rather than in front of the camera.
    if (!placed.current) azimuth.current = chapter === "intro" ? -0.7 : Math.atan2(OVERVIEW_DIR.x, OVERVIEW_DIR.z);
    else if (controls) azimuth.current = Math.atan2(cur.x, cur.z);
    if (!controls && autoRotate) azimuth.current += dt * 0.07;
    const dirAt = (elev: number) => new Vector3(Math.sin(azimuth.current) * Math.cos(elev), Math.sin(elev), Math.cos(azimuth.current) * Math.cos(elev));

    const target = goalTarget.current;
    const pos = goalPos.current;
    const fitV = 0.72;
    switch (chapter) {
      case "mutation":
      case "selection": {
        target.copy(tipOf(chapter === "mutation" ? currentId : layout.bestId));
        pos.copy(target).addScaledVector(dirAt(0.12), 6);
        break;
      }
      case "test": {
        target.set(bounds.shell[0], (layout.testY ?? 1.5) * 0.5 + 0.4, bounds.shell[2]);
        pos.copy(target).addScaledVector(dirAt(0.2), Math.max(6, (layout.testY ?? 2) * 1.6 + 3));
        break;
      }
      case "nutrients": {
        target.set(bounds.center[0], 1.4, bounds.center[2]);
        const dir = dirAt(0.12);
        pos.copy(target).addScaledVector(dir, fitDistance(pts, target, dir, tanV, aspect, 0.8, 0.9) * 1.15);
        break;
      }
      case "ceiling": {
        const y = layout.surfaceY ?? bounds.top;
        target.set(bounds.center[0], y - 0.6, bounds.center[2]);
        const dir = dirAt(-0.42);
        pos.copy(target).addScaledVector(dir, fitDistance(pts, target, dir, tanV, aspect, 1.6, 0.9) * 0.75);
        break;
      }
      default: {
        // overview / intro: the whole current reef, ~72% of the frame height.
        const intro = chapter === "intro";
        const dir = dirAt(intro ? -0.08 : 0.2);
        target.copy(centerOf(pts));
        const f = focusId ? layout.nodes.find((n) => n.id === focusId) : undefined;
        if (f && !intro) target.lerp(new Vector3(...f.tip), 0.55);
        // Portrait heroes fit by height only (side-shoots may crop) so the reef stays large behind the text.
        const fillH = intro && aspect < 0.75 ? 1.8 : 0.86;
        const d = fitDistance(pts, target, dir, tanV, aspect, intro ? (aspect < 0.75 ? 0.55 : 0.46) : fitV, fillH);
        pos.copy(target).addScaledVector(dir, f && !intro ? d * 0.72 : d);
      }
    }
    // The camera always stays under water (the surface is only ever seen from below).
    pos.y = Math.min(pos.y, ceilY);

    if (!placed.current) {
      camera.position.copy(pos);
      look.current.copy(target);
      placed.current = true;
    } else {
      const lam = animate ? 1.8 : 1000;
      camera.position.set(damp(camera.position.x, pos.x, lam, dt), damp(camera.position.y, pos.y, lam, dt), damp(camera.position.z, pos.z, lam, dt));
      look.current.set(damp(look.current.x, target.x, lam, dt), damp(look.current.y, target.y, lam, dt), damp(look.current.z, target.z, lam, dt));
    }
    if (ctrl.current) ctrl.current.target.copy(look.current);
    else camera.lookAt(look.current);
  });

  if (!controls) return null;
  return (
    <OrbitControls
      ref={ctrl}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      enablePan={false}
      enableZoom={false}
      minPolarAngle={Math.PI * 0.2}
      maxPolarAngle={Math.PI * 0.6}
      rotateSpeed={0.6}
      autoRotate={autoRotate && chapter === "overview" && !focusId}
      autoRotateSpeed={0.35}
      onStart={() => {
        user.current.dragging = true;
      }}
      onEnd={() => {
        user.current.dragging = false;
        user.current.last = performance.now() / 1000;
      }}
    />
  );
}
