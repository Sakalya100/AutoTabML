"use client";

/**
 * The whole tree in two draw calls: every branch segment (experiment limbs, their fractal twigs, the surface roots)
 * is one instance of a tube template whose Bézier is evaluated in the vertex shader, and every leaf/polyp is one
 * instance of a billboard quad.
 *
 * Why it never pops:
 *   - Geometry is never rebuilt. Layout changes only update per-instance data (control points, radii, timestamps).
 *   - Every node's shape (control points relative to its attach point, and its radii) follows its layout target on
 *     a critically damped spring, so a live run rescaling its heights glides instead of snapping. A child's base is
 *     re-derived from its parent's *current* curve each frame, so junctions stay glued while things move.
 *   - Growth, bleaching, colour changes, leaf fall and death are timestamps compared with `uNow` in the shaders, so
 *     they animate on the GPU with nothing uploaded per frame once the springs are at rest.
 *   - New experiments are scheduled sequentially (a birth queue): a seek that delivers twenty experiments at once
 *     grows them one after another, each starting once its parent's growth front has passed the attach point.
 *   - Removed experiments (a backward seek, a loop restart) retract and dissolve, newest first, instead of vanishing.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BufferAttribute, Color, DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, Vector3, type Mesh, type PerspectiveCamera } from "three";
import { REEF, type ReefLayout, type ReefNode } from "@/lib/scene/contract";
import { hash01 } from "@/lib/scene/layout";
import { tipLeaves, twigSpecs, type TwigSpec } from "@/lib/scene/twigs";
import { leafFrag, leafVert, treeFrag, treeVert } from "./shaders";
import { mulberry32, springStep, useReef, useShaderMaterial } from "./shared";

type V3 = [number, number, number];
const NEVER = 1e9;
const PAST = -1e4;

// ------------------------------------------------------------------ palette (linear RGB)

const lin = (hex: string): V3 => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};
const TINT = {
  keep: lin("#3fe0c0"),
  best: lin("#f5c46a"),
  running: lin("#7fe6ff"),
  discard: lin("#86cfd0"),
  crash: lin(REEF.crash),
  root: lin("#2fb3a2"),
  rootBest: lin("#e9b25c"),
};
const LEAF = { keep: lin("#6dffd8"), best: lin("#ffd890"), dry: lin("#7d746a") };

const KIND = { living: 0, discard: 1, crash: 2, running: 3, root: 4 } as const;

// ------------------------------------------------------------------ templates

function tubeTemplate(seg: number, radial: number, caps: number): InstancedBufferGeometry {
  const rings: [number, number][] = []; // [t, cap]
  for (let c = caps; c >= 1; c--) rings.push([0, -c / caps]);
  for (let i = 0; i <= seg; i++) rings.push([i / seg, 0]);
  for (let c = 1; c <= caps; c++) rings.push([1, c / caps]);
  const pos = new Float32Array(rings.length * (radial + 1) * 3);
  let k = 0;
  for (const [t, cap] of rings)
    for (let j = 0; j <= radial; j++) {
      pos[k++] = t;
      pos[k++] = (j / radial) * Math.PI * 2;
      pos[k++] = cap;
    }
  const idx: number[] = [];
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + 1;
      const c = a + radial + 1;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function quadTemplate(): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  return g;
}

const SEG_ATTRS: [string, number][] = [
  ["aP0", 4],
  ["aP1", 4],
  ["aP2", 4],
  ["aP3", 4],
  ["aGrow", 4],
  ["aLife", 4],
  ["aCol0", 4],
  ["aCol1", 4],
  ["aFx", 2],
];
const LEAF_ATTRS: [string, number][] = [
  ["aAnchor", 4],
  ["aDir", 4],
  ["aLeafT", 4],
  ["aLCol0", 3],
  ["aLCol1", 3],
];

/** Instanced attributes with a capacity; grows (rarely) by swapping in a fresh geometry. */
class Pool {
  geo: InstancedBufferGeometry;
  arrays: Record<string, Float32Array> = {};
  cap = 0;
  count = 0;
  constructor(
    private template: () => InstancedBufferGeometry,
    private layout: [string, number][],
    cap: number,
  ) {
    this.geo = template();
    this.alloc(cap);
  }
  private alloc(cap: number) {
    const old = this.arrays;
    this.cap = cap;
    for (const [name, size] of this.layout) {
      const arr = new Float32Array(cap * size);
      if (old[name]) arr.set(old[name].subarray(0, Math.min(old[name].length, arr.length)));
      this.arrays[name] = arr;
      const attr = new InstancedBufferAttribute(arr, size);
      attr.setUsage(35048); // DynamicDrawUsage
      this.geo.setAttribute(name, attr);
    }
  }
  ensure(n: number): boolean {
    if (n <= this.cap) return false;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    const old = this.geo;
    this.geo = this.template();
    this.alloc(cap);
    old.dispose();
    return true;
  }
  commit(n: number) {
    this.count = n;
    this.geo.instanceCount = n;
    for (const [name, size] of this.layout) {
      const a = this.geo.getAttribute(name) as InstancedBufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n) * size);
      a.needsUpdate = true;
    }
  }
  dispose() {
    this.geo.dispose();
  }
}

// ------------------------------------------------------------------ math

const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: readonly number[], s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len3 = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a: readonly number[]): V3 => {
  const l = len3(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** c = 12 floats (4 control points). */
function bez(c: Float64Array | number[], t: number): V3 {
  const u = 1 - t;
  const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
  return [0, 1, 2].map((i) => w0 * c[i] + w1 * c[3 + i] + w2 * c[6 + i] + w3 * c[9 + i]) as V3;
}
function bezTan(c: Float64Array | number[], t: number): V3 {
  const u = 1 - t;
  const a = 3 * u * u, b = 6 * u * t, e = 3 * t * t;
  const d = [0, 1, 2].map((i) => a * (c[3 + i] - c[i]) + b * (c[6 + i] - c[3 + i]) + e * (c[9 + i] - c[6 + i]));
  return len3(d) > 1e-9 ? nrm(d) : nrm([c[9] - c[0], c[10] - c[1], c[11] - c[2]]);
}
function frameOf(T: V3): [V3, V3] {
  const ref: V3 = Math.abs(T[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
  const B = nrm(cross(T, ref));
  return [cross(B, T), B];
}
/** Arc length estimate of a cubic (average of chord and control polygon). */
function arcLen(c: Float64Array | number[]): number {
  const chord = Math.hypot(c[9] - c[0], c[10] - c[1], c[11] - c[2]);
  let poly = 0;
  for (let i = 0; i < 3; i++) poly += Math.hypot(c[3 * i + 3] - c[3 * i], c[3 * i + 4] - c[3 * i + 1], c[3 * i + 5] - c[3 * i + 2]);
  return (chord + poly) / 2;
}
const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

// ------------------------------------------------------------------ per-node state

/** Spring state layout: p0 (3, roots only), d1, d2, d3 (control points relative to p0), rBase, rTip. */
const NS = 14;
const OMEGA = 5.2; // critically damped, settles in ~0.9 s

interface Sched {
  start: number;
  dur: number;
  from: number;
  to: number;
}

interface NState {
  key: string;
  id: string;
  node: ReefNode;
  parent: NState | null;
  attachT: number;
  status: ReefNode["status"];
  goal: Float64Array;
  x: Float64Array;
  v: Float64Array;
  born: number;
  mainDur: number;
  speed: number;
  g: Sched;
  twigsAt: number;
  bleachAt: number;
  dieAt: number;
  col: { from: V3; to: V3; at: number };
  leaf: { from: V3; to: V3; at: number };
  kind: number;
  glow: number;
  hl: number;
  hlV: number;
  twigs: TwigSpec[] | null;
  tipLeafN: number;
  settled: boolean;
  seed: number;
  // resolved each rebuild
  c: Float64Array;
  arc0: number;
  arcLen: number;
  stamp: number;
}

function attachKind(n: ReefNode): "r" | "k" | "s" {
  if (!n.parentId) return "r";
  if ((n.attachT ?? (n.status === "keep" ? 1 : 0.5)) >= 1) return "k";
  return "s";
}

function tintOf(n: ReefNode, bestId: string | null): V3 {
  if (n.status === "running") return TINT.running;
  if (n.status === "discard") return TINT.discard;
  if (n.status === "crash") return TINT.crash;
  if (!n.parentId) return n.isBest ? TINT.rootBest : TINT.root;
  return n.isBest || n.id === bestId ? TINT.best : TINT.keep;
}
function leafTintOf(n: ReefNode): V3 {
  return n.isBest ? LEAF.best : LEAF.keep;
}
function kindOf(n: ReefNode): number {
  if (n.status === "running") return KIND.running;
  if (n.status === "discard") return KIND.discard;
  if (n.status === "crash") return KIND.crash;
  return KIND.living;
}
function glowOf(n: ReefNode): number {
  if (n.status === "crash") return 0;
  if (n.status === "discard") return 0.5;
  if (n.status === "running") return 1;
  return n.isBest ? 1.1 : 0.8;
}

function goalOf(n: ReefNode, out: Float64Array) {
  const b = n.base;
  const c1 = n.c1 ?? [b[0], b[1] + (n.tip[1] - b[1]) * 0.4, b[2]];
  const c2 = n.c2 ?? [n.tip[0], b[1] + (n.tip[1] - b[1]) * 0.7, n.tip[2]];
  out[0] = b[0];
  out[1] = b[1];
  out[2] = b[2];
  for (let i = 0; i < 3; i++) {
    out[3 + i] = c1[i] - b[i];
    out[6 + i] = c2[i] - b[i];
    out[9 + i] = n.tip[i] - b[i];
  }
  out[12] = n.rBase ?? 0.07;
  out[13] = n.rTip ?? 0.03;
}

function growthAt(s: Sched, now: number): number {
  const k = s.dur > 0 ? Math.min(1, Math.max(0, (now - s.start) / s.dur)) : 1;
  return s.from + (s.to - s.from) * ease(k);
}
function colorAt(c: { from: V3; to: V3; at: number }, now: number): V3 {
  const k = Math.min(1, Math.max(0, (now - c.at) / 1.4));
  const s = k * k * (3 - 2 * k);
  return [c.from[0] + (c.to[0] - c.from[0]) * s, c.from[1] + (c.to[1] - c.from[1]) * s, c.from[2] + (c.to[2] - c.from[2]) * s];
}

// ------------------------------------------------------------------ component

export interface ReefTreeProps {
  layout: ReefLayout;
  hoveredId?: string | null;
  selectedId?: string | null;
  interactive?: boolean;
  onHover?: (id: string | null) => void;
  onSelect?: (id: string) => void;
}

export function ReefTree({ layout, hoveredId = null, selectedId = null, interactive = false, onHover, onSelect }: ReefTreeProps) {
  const { animate, lite } = useReef();
  const get = useThree((s) => s.get);
  const gl = useThree((s) => s.gl);

  const segMat = useShaderMaterial({
    vertexShader: treeVert,
    fragmentShader: treeFrag,
    uniforms: { uNow: { value: 0 }, uSway: { value: animate ? (lite ? 0.12 : 0.16) : 0 }, uPx: { value: 800 }, uMinPx: { value: 0.65 } },
  });
  const leafMat = useShaderMaterial({
    vertexShader: leafVert,
    fragmentShader: leafFrag,
    additive: true,
    side: DoubleSide,
    uniforms: { uNow: { value: 0 }, uSway: { value: animate ? (lite ? 0.12 : 0.16) : 0 }, uPx: { value: 800 } },
  });

  const tree = useMemo(() => {
    const seg = lite ? 14 : 22;
    const radial = lite ? 6 : 9;
    return {
      segs: new Pool(() => tubeTemplate(seg, radial, 3), SEG_ATTRS, 256),
      leaves: new Pool(quadTemplate, LEAF_ATTRS, 512),
      states: new Map<string, NState>(),
      alive: new Map<string, NState>(),
      lastBirth: -Infinity,
      dirty: true,
      first: true,
      stamp: 0,
      gen: 0,
      hover: { x: 0, y: 0, moved: false, inside: false, down: null as null | { x: number; y: number }, id: null as string | null },
    };
  }, [lite]);
  const segRef = useRef<Mesh>(null);
  const leafRef = useRef<Mesh>(null);
  useEffect(() => () => {
    tree.segs.dispose();
    tree.leaves.dispose();
  }, [tree]);

  // ---------------------------------------------------------------- diff the layout into node states
  useLayoutEffect(() => {
    const now = get().clock.elapsedTime;
    const initial = tree.first;
    tree.first = false;
    const want = new Map(layout.nodes.map((n) => [n.id, n]));

    // Removed experiments retract and dissolve, newest first.
    const gone = [...tree.alive.values()].filter((s) => !want.has(s.id)).sort((a, b) => b.node.index - a.node.index);
    gone.forEach((s, i) => kill(s, now + Math.min(1.4, i * 0.05)));

    let order = 0;
    for (const n of layout.nodes) {
      const cur = tree.alive.get(n.id);
      const regressed = cur && cur.status !== "running" && n.status === "running";
      if (cur && attachKind(n) === cur.key.split("|")[1] && !regressed) update(cur, n, now);
      else {
        // A new experiment, or a running bud promoted to a kept limb (it moves from the stem to the parent's tip):
        // the old bud retracts while the new limb grows — never a slide.
        if (cur) kill(cur, now);
        create(n, now, initial, order++);
      }
    }
    // Children follow whichever state currently embodies their parent (a promoted bud gets a new state).
    for (const st of tree.alive.values()) if (st.node.parentId) st.parent = tree.alive.get(st.node.parentId) ?? st.parent;
    tree.dirty = true;

    function kill(s: NState, at: number) {
      if (!animate) {
        tree.states.delete(s.key);
      } else s.dieAt = Math.min(s.dieAt, at);
      if (tree.alive.get(s.id) === s) tree.alive.delete(s.id);
    }

    function create(n: ReefNode, t: number, init: boolean, ord: number) {
      const goal = new Float64Array(NS);
      goalOf(n, goal);
      const parent = n.parentId ? (tree.alive.get(n.parentId) ?? null) : null;
      const attachT = n.parentId ? Math.min(1, Math.max(0, n.attachT ?? (n.status === "keep" ? 1 : 0.5))) : 0;
      const speed = init ? 0.6 : 1;
      const length = len3([goal[9], goal[10], goal[11]]);
      const mainDur = speed * (0.85 + 0.35 * Math.min(1, length / 3));
      const parentReady = parent ? parent.born + parent.mainDur * (0.2 + 0.75 * attachT) : -Infinity;
      let born: number;
      if (!animate) born = PAST;
      else if (init) born = Math.max(t + 0.2 + ord * 0.04, parentReady);
      else {
        born = Math.max(t + 0.03, tree.lastBirth + 0.14, parentReady);
        tree.lastBirth = born;
      }
      const decided = n.status !== "running";
      const s: NState = {
        key: `${n.id}|${attachKind(n)}|${tree.gen++}`,
        id: n.id,
        node: n,
        parent,
        attachT,
        status: n.status,
        goal,
        x: Float64Array.from(goal),
        v: new Float64Array(NS),
        born,
        mainDur,
        speed,
        g: animate
          ? { start: born, dur: decided ? mainDur : 3.2, from: 0, to: n.status === "crash" ? 0.6 : decided ? 1 : 0.7 }
          : { start: PAST, dur: 0, from: 1, to: n.status === "crash" ? 0.6 : decided ? 1 : 0.7 },
        twigsAt: decided && n.status !== "crash" ? (animate ? born + mainDur * 0.55 : PAST) : NEVER,
        bleachAt: n.status === "discard" ? (init || !animate ? PAST : born + mainDur * 0.55 + 2.0) : NEVER,
        dieAt: NEVER,
        col: { from: tintOf(n, layout.bestId), to: tintOf(n, layout.bestId), at: PAST },
        leaf: { from: leafTintOf(n), to: leafTintOf(n), at: PAST },
        kind: kindOf(n),
        glow: glowOf(n),
        hl: 0,
        hlV: 0,
        twigs: decided ? twigSpecs(n, lite) : null,
        tipLeafN: decided ? tipLeaves(n, lite) : 0,
        settled: init || !animate,
        seed: hash01(n.id),
        c: new Float64Array(12),
        arc0: 0,
        arcLen: 1,
        stamp: -1,
      };
      tree.states.set(s.key, s);
      tree.alive.set(n.id, s);
    }

    function update(s: NState, n: ReefNode, t: number) {
      s.node = n;
      goalOf(n, s.goal);
      if (s.dieAt < NEVER) s.dieAt = NEVER; // revived (seeked back and forth quickly)
      const decidedNow = s.status === "running" && n.status !== "running";
      if (decidedNow) {
        // The decision lands: the bud finishes its extension from wherever it is, then unfurls (or chars).
        const start = Math.max(t, s.born);
        s.g = animate ? { start, dur: 0.75, from: growthAt(s.g, start), to: n.status === "crash" ? 0.6 : 1 } : { start: PAST, dur: 0, from: 1, to: n.status === "crash" ? 0.6 : 1 };
        s.twigs = n.status === "crash" ? [] : twigSpecs(n, lite);
        s.tipLeafN = tipLeaves(n, lite);
        s.twigsAt = n.status === "crash" ? NEVER : animate ? start + 0.45 : PAST;
        if (n.status === "discard") s.bleachAt = animate ? s.twigsAt + 2.0 : PAST;
      }
      s.status = n.status;
      s.kind = kindOf(n);
      s.glow = glowOf(n);
      const tint = tintOf(n, layout.bestId);
      if (tint.some((v, i) => Math.abs(v - s.col.to[i]) > 1e-4)) s.col = { from: colorAt(s.col, t), to: tint, at: animate ? t : PAST };
      const lt = leafTintOf(n);
      if (lt.some((v, i) => Math.abs(v - s.leaf.to[i]) > 1e-4)) s.leaf = { from: colorAt(s.leaf, t), to: lt, at: animate ? t : PAST };
      if (!animate) s.x.set(s.goal);
    }
  }, [layout, tree, get, animate, lite]);

  // ---------------------------------------------------------------- picking (interactive)
  useEffect(() => {
    if (!interactive) return;
    const el = gl.domElement;
    const h = tree.hover;
    const pos = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      h.x = e.clientX - r.left;
      h.y = e.clientY - r.top;
    };
    const move = (e: PointerEvent) => {
      pos(e);
      h.moved = true;
      h.inside = true;
    };
    const leave = () => {
      h.inside = false;
      h.moved = true;
    };
    const down = (e: PointerEvent) => {
      pos(e);
      h.down = { x: h.x, y: h.y };
      h.moved = true;
      h.inside = true;
    };
    const up = (e: PointerEvent) => {
      pos(e);
      const d = h.down;
      h.down = null;
      if (d && Math.hypot(h.x - d.x, h.y - d.y) < 6) {
        const id = pick();
        if (id) onSelect?.(id);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pick reads refs only
  }, [interactive, gl, tree, onSelect]);

  const proj = useMemo(() => new Vector3(), []);
  function pick(): string | null {
    const h = tree.hover;
    if (!h.inside) return null;
    const { camera, size } = get();
    let best: string | null = null;
    let bestD = 16;
    for (const s of tree.alive.values()) {
      if (s.stamp < 0) continue;
      let px = 0, py = 0;
      for (let i = 0; i <= 8; i++) {
        const p = bez(s.c, i / 8);
        proj.set(p[0], p[1], p[2]).project(camera);
        if (proj.z > 1) continue;
        const x = ((proj.x + 1) / 2) * size.width;
        const y = ((1 - proj.y) / 2) * size.height;
        if (i > 0) {
          const dx = x - px, dy = y - py;
          const l2 = dx * dx + dy * dy || 1;
          const u = Math.min(1, Math.max(0, ((h.x - px) * dx + (h.y - py) * dy) / l2));
          const d = Math.hypot(h.x - (px + u * dx), h.y - (py + u * dy));
          if (d < bestD) {
            bestD = d;
            best = s.id;
          }
        }
        px = x;
        py = y;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- per frame
  useFrame((state, rawDt) => {
    const now = state.clock.elapsedTime;
    const dt = Math.min(rawDt, 1 / 20);
    segMat.uniforms.uNow.value = now;
    leafMat.uniforms.uNow.value = now;
    const cam = state.camera as PerspectiveCamera;
    const px = (state.size.height * state.viewport.dpr) / (2 * Math.tan(((cam.fov ?? 38) * Math.PI) / 360));
    segMat.uniforms.uPx.value = px;
    leafMat.uniforms.uPx.value = px;

    // Springs (shape + radii) and highlight — critically damped, exact for any frame time.
    let moving = false;
    const o = { v: 0 };
    for (const s of tree.states.values()) {
      const hlGoal = s.id === hoveredId || s.id === selectedId ? 1 : 0;
      if (Math.abs(s.hl - hlGoal) > 1e-3 || Math.abs(s.hlV) > 1e-3) {
        s.hl = animate ? springStep(s.hl, s.hlV, hlGoal, 12, dt, o) : hlGoal;
        s.hlV = animate ? o.v : 0;
        moving = true;
      } else {
        s.hl = hlGoal;
        s.hlV = 0;
      }
      let active = false;
      for (let i = 0; i < NS; i++) if (Math.abs(s.goal[i] - s.x[i]) > 1e-4 || Math.abs(s.v[i]) > 1e-4) active = true;
      if (!active) continue;
      for (let i = 0; i < NS; i++) {
        if (!animate) {
          s.x[i] = s.goal[i];
          s.v[i] = 0;
          continue;
        }
        s.x[i] = springStep(s.x[i], s.v[i], s.goal[i], OMEGA, dt, o);
        s.v[i] = o.v;
      }
      moving = true;
    }
    // Forget the dissolved.
    for (const [k, s] of tree.states)
      if (s.dieAt < NEVER && now > s.dieAt + 1.0) {
        tree.states.delete(k);
        tree.dirty = true;
      }

    if (moving || tree.dirty) rebuild();
    tree.dirty = false;

    if (interactive && tree.hover.moved) {
      tree.hover.moved = false;
      const id = pick();
      if (id !== tree.hover.id) {
        tree.hover.id = id;
        onHover?.(id);
      }
    }
  });

  // ---------------------------------------------------------------- instance data
  function rebuild() {
    const stamp = ++tree.stamp;
    let segN = 0;
    let leafN = 0;
    // Upper bound for capacity.
    let segMax = 0, leafMax = 0;
    for (const s of tree.states.values()) {
      segMax += 1 + (s.node.parentId ? 0 : 5) + (s.twigs?.length ?? 0);
      leafMax += s.tipLeafN + (s.twigs?.reduce((a, b) => a + b.leaves, 0) ?? 0);
    }
    if (tree.segs.ensure(segMax) && segRef.current) segRef.current.geometry = tree.segs.geo;
    if (tree.leaves.ensure(leafMax) && leafRef.current) leafRef.current.geometry = tree.leaves.geo;
    const S = tree.segs.arrays;
    const L = tree.leaves.arrays;

    const resolve = (s: NState) => {
      if (s.stamp === stamp) return;
      const p = s.parent;
      let p0: V3;
      if (p) {
        if (p.stamp !== stamp) resolve(p);
        p0 = s.attachT >= 1 ? [p.c[9], p.c[10], p.c[11]] : bez(p.c, s.attachT);
        s.arc0 = p.arc0 + p.arcLen * s.attachT;
      } else {
        p0 = [s.x[0], s.x[1], s.x[2]];
        s.arc0 = 0;
      }
      for (let i = 0; i < 3; i++) {
        s.c[i] = p0[i];
        s.c[3 + i] = p0[i] + s.x[3 + i];
        s.c[6 + i] = p0[i] + s.x[6 + i];
        s.c[9 + i] = p0[i] + s.x[9 + i];
      }
      s.arcLen = arcLen(s.c);
      s.stamp = stamp;
    };

    const writeSeg = (
      c: ArrayLike<number>,
      r0: number,
      r1: number,
      flare: number,
      seed: number,
      g: Sched,
      s: NState,
      arc0: number,
      arcL: number,
      kind: number,
      glow: number,
      tintScale = 1,
    ) => {
      const i = segN++;
      const o4 = i * 4;
      S.aP0.set([c[0], c[1], c[2], r0], o4);
      S.aP1.set([c[3], c[4], c[5], r1], o4);
      S.aP2.set([c[6], c[7], c[8], flare], o4);
      S.aP3.set([c[9], c[10], c[11], seed], o4);
      S.aGrow.set([g.start, g.dur, g.from, g.to], o4);
      S.aLife.set([s.dieAt, s.bleachAt, arc0, arcL], o4);
      S.aCol0.set([s.col.from[0] * tintScale, s.col.from[1] * tintScale, s.col.from[2] * tintScale, s.col.at], o4);
      S.aCol1.set([s.col.to[0] * tintScale, s.col.to[1] * tintScale, s.col.to[2] * tintScale, kind], o4);
      S.aFx.set([glow, s.hl], i * 2);
    };

    const writeLeaf = (anchor: V3, size: number, dir: V3, seed: number, bornAt: number, fallAt: number, s: NState, dryTo: boolean) => {
      const i = leafN++;
      const o4 = i * 4;
      L.aAnchor.set([anchor[0], anchor[1], anchor[2], size], o4);
      L.aDir.set([dir[0], dir[1], dir[2], seed], o4);
      L.aLeafT.set([bornAt, fallAt, s.dieAt, dryTo ? s.bleachAt + 0.2 : s.leaf.at], o4);
      const from = dryTo ? s.leaf.to : s.leaf.from;
      const to = dryTo ? LEAF.dry : s.leaf.to;
      L.aLCol0.set(from, i * 3);
      L.aLCol1.set(to, i * 3);
    };

    const tmpC = new Float64Array(12);
    for (const s of tree.states.values()) {
      resolve(s);
      const n = s.node;
      const r0 = s.x[12];
      const r1 = Math.min(s.x[13], r0);
      const root = !n.parentId;
      writeSeg(s.c, r0, r1, root ? 0.9 : 0, s.seed, s.g, s, s.arc0, s.arcLen, s.kind, s.glow);

      const rnd = mulberry32(Math.floor(s.seed * 1e6) + 17);
      // Surface roots: the baseline anchors itself in the sand.
      if (root) {
        for (let k = 0; k < 5; k++) {
          const a = s.seed * Math.PI * 2 + k * 2.39996 + (rnd() - 0.5) * 0.4;
          const o: V3 = [Math.cos(a), 0, Math.sin(a)];
          // Roots spread in proportion to the trunk they anchor (a seedling has rootlets, an old trunk a buttress).
          const L0 = Math.min(2.2, r0 * (5 + 4 * rnd()));
          const side: V3 = [-o[2], 0, o[0]];
          const bend = (rnd() - 0.5) * 0.9;
          const st: V3 = [s.c[0] + o[0] * r0 * 0.3, s.c[1] + 0.3 + 0.12 * rnd(), s.c[2] + o[2] * r0 * 0.3];
          const en: V3 = [s.c[0] + o[0] * (L0 + r0) + side[0] * bend, -0.04, s.c[2] + o[2] * (L0 + r0) + side[2] * bend];
          // Down the flare, then along the sand, curling slightly sideways.
          // Stay on top of the sand (the seabed is flat at y≈0) and only dive in at the very end — no slivers poking out.
          const lie = r0 * 0.3 + 0.03;
          const cc = [...st, st[0] + o[0] * L0 * 0.3, lie + 0.06, st[2] + o[2] * L0 * 0.3, en[0] - o[0] * L0 * 0.3 - side[0] * bend * 0.5, lie, en[2] - o[2] * L0 * 0.3 - side[2] * bend * 0.5, ...en];
          writeSeg(cc, r0 * (0.36 + 0.1 * rnd()), r0 * 0.1, 0, rnd(), { start: s.g.start + 0.05 * k, dur: s.mainDur * 1.1, from: 0, to: 1 }, s, 0, L0, KIND.root, 0.4, 0.75);
        }
      }

      // Leaves at the experiment's own tip.
      const shed = n.status === "discard";
      const showLeaves = !(shed && s.settled);
      const crownAt = s.twigsAt < NEVER ? s.twigsAt + 0.35 * s.speed : NEVER;
      const leafSize = (shed ? 0.16 : 0.24) * (0.85 + 0.35 * (n.vigour ?? 0.5)) * (n.isBest ? 1.1 : 1);
      if (showLeaves && s.tipLeafN && crownAt < NEVER) {
        const T = bezTan(s.c, 1);
        const [N, B] = frameOf(T);
        for (let j = 0; j < s.tipLeafN; j++) {
          const u = 0.8 + 0.2 * ((j + 0.5) / s.tipLeafN);
          const p = bez(s.c, u);
          const a = s.seed * 6.28 + j * 2.39996;
          const dir = nrm(add(add(scl(T, 0.8), scl(N, Math.cos(a) * 1.1)), add(scl(B, Math.sin(a) * 1.1), [0, 0.3, 0])));
          const fall = shed ? s.bleachAt + 0.3 + 1.6 * rnd() : NEVER;
          writeLeaf(p, leafSize * (0.8 + 0.4 * rnd()), dir, rnd(), crownAt + 0.25 + j * 0.05, fall, s, shed);
        }
      }

      // Fractal twigs, resolved against the branch's current curve.
      if (!s.twigs || !s.twigs.length || s.twigsAt >= NEVER) continue;
      const curves: { c: Float64Array; r0: number; r1: number; g: Sched; arc0: number; len: number }[] = [];
      for (let k = 0; k < s.twigs.length; k++) {
        const tw = s.twigs[k];
        const par = tw.parent < 0 ? { c: s.c, r0, r1, g: s.g, arc0: s.arc0, len: s.arcLen } : curves[tw.parent];
        const P = bez(par.c, tw.t);
        const T = bezTan(par.c, tw.t);
        const [N, B] = frameOf(T);
        const se = Math.sin(tw.elev);
        const dir = nrm(add(scl(T, Math.cos(tw.elev)), add(scl(N, Math.cos(tw.azimuth) * se), scl(B, Math.sin(tw.azimuth) * se))));
        const L0 = Math.max(0.08, tw.len * par.len);
        const lift = shed ? -0.1 : 0.22; // living twigs reach for the light; dry ones sag
        const end = add(add(P, scl(dir, L0)), [0, L0 * lift, 0]);
        const arrive = nrm(add(scl(dir, 0.6), [0, shed ? -0.1 : 0.4, 0]));
        const c = tmpC;
        c.set([...P, ...add(P, scl(dir, L0 * 0.38)), ...add(end, scl(arrive, -L0 * 0.32)), ...end]);
        const rp = par.r0 + (par.r1 - par.r0) * tw.t;
        const tr0 = Math.max(0.006, tw.r * rp);
        const terminal = tw.leaves > 0;
        const tr1 = Math.max(0.005, tr0 * (terminal ? 0.3 : 0.5));
        const lvlDur = (tw.level === 1 ? 0.6 : tw.level === 2 ? 0.48 : 0.4) * s.speed;
        const start = tw.parent < 0 ? s.twigsAt + 0.5 * tw.t * s.speed + k * 0.025 : par.g.start + par.g.dur * (0.35 + 0.55 * tw.t);
        const g: Sched = { start, dur: lvlDur, from: 0, to: 1 };
        const arc0 = par.arc0 + par.len * tw.t;
        const cl = arcLen(c);
        writeSeg(c, tr0, tr1, 0, rnd(), g, s, arc0, cl, s.kind, s.glow * 0.7, 1.08);
        curves.push({ c: Float64Array.from(c), r0: tr0, r1: tr1, g, arc0, len: cl });
        if (showLeaves && terminal) {
          for (let j = 0; j < tw.leaves; j++) {
            const u = 0.45 + 0.55 * ((j + 0.5) / tw.leaves);
            const p = bez(c, u);
            const T2 = bezTan(c, u);
            const [N2, B2] = frameOf(T2);
            const a = rnd() * 6.28;
            const ldir = nrm(add(add(scl(T2, 0.7), scl(N2, Math.cos(a) * 1.15)), add(scl(B2, Math.sin(a) * 1.15), [0, 0.35, 0])));
            const fall = shed ? s.bleachAt + 0.2 + 1.8 * rnd() : NEVER;
            writeLeaf(p, leafSize * (0.75 + 0.4 * rnd()), ldir, rnd(), start + lvlDur * (0.55 + 0.45 * u) + j * 0.04, fall, s, shed);
          }
        }
      }
    }
    tree.segs.commit(segN);
    tree.leaves.commit(leafN);
  }

  return (
    <group>
      <mesh ref={segRef} geometry={tree.segs.geo} material={segMat} frustumCulled={false} renderOrder={1} />
      <mesh ref={leafRef} geometry={tree.leaves.geo} material={leafMat} frustumCulled={false} renderOrder={7} />
    </group>
  );
}
