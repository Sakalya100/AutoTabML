"use client";

import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Quaternion, ShaderMaterial, SphereGeometry, Vector3 } from "three";
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
  const { u, scrub } = useSurvey();
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
    const gate = scrub?.current?.gates;
    // Landing: presence follows the mist section (already eased by the page); run pages: on once there is a best.
    op.current = gate ? (on ? gate.mist : 0) : damp(op.current, on ? 1 : 0, 2.5, Math.min(dt, 0.05));
    const t = Math.max(thickness, 0.12);
    mats.forEach((m, i) => {
      const k = i / (MIST_SHEETS - 1);
      m.uniforms.uY.value = (bestY ?? 0) - t + k * t * 1.6;
      m.uniforms.uHug.value = t * 0.9;
      m.uniforms.uOpacity.value = op.current * 0.085;
    });
    if (sheets.current) sheets.current.visible = op.current > 0.004;
  });
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
  const { u, animate, scrub } = useSurvey();
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
    const gate = scrub?.current?.gates;
    if (gate && cloudY != null) {
      // Landing: the deck descends through the ceiling section and settles on the fitted asymptote, as a pure
      // function of scroll (reversible); its presence is the section's.
      const k = gate.cloudDrop;
      s.y = cloudY + 6 * (1 - k) * (1 - k);
      s.op = gate.cloud * 0.8;
    } else if (cloudY == null) {
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

const LABEL_FONT = 0.12;
const LABEL_GAP = 0.27; // minimum vertical spacing between labels (world)
const LABEL_X = 0.2; // label start, right of the rod (world)
const CHAR_W = 0.078; // approximate advance of one mono glyph at LABEL_FONT (world)

/**
 * Pick the rod's foot: try sites around the summit and, seen from the truth shot, keep the one whose labels sit
 * furthest (on screen) from everything else drawn there — the climb path, the keep rings and lanterns, and the bead.
 * The readings can sit far below the ground, so this has to be judged in projection, not on the map.
 */
function rodSite(
  summit: [number, number, number],
  climb: [number, number, number][],
  marks: number[],
  placed: number[],
  widths: number[],
  ground: (x: number, z: number) => number,
): [number, number] {
  const ys = [summit[1], ...marks];
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const cam = new PerspectiveCamera(32, 1.6, 0.1, 200);
  cam.position.set(summit[0] + 7.5, mid + 2.0, summit[2] + 8.75);
  cam.lookAt(summit[0] + 0.5, mid, summit[2] + 0.6);
  cam.updateMatrixWorld();
  const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const v = new Vector3();
  const proj = (x: number, y: number, z: number): [number, number] => {
    v.set(x, y, z).project(cam);
    return [v.x * 1.6, v.y];
  };
  // everything the labels must not cover
  const obstacles: [number, number][] = [];
  for (let i = 0; i + 1 < climb.length; i++) {
    const [ax, , az] = climb[i];
    const [bx, , bz] = climb[i + 1];
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.2));
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n;
      const z = az + ((bz - az) * k) / n;
      obstacles.push(proj(x, ground(x, z), z));
    }
  }
  for (const c of climb) {
    for (let k = 0; k < 8; k++) {
      const x = c[0] + Math.cos((k / 8) * Math.PI * 2) * 0.3;
      const z = c[2] + Math.sin((k / 8) * Math.PI * 2) * 0.3;
      obstacles.push(proj(x, ground(x, z), z));
    }
    obstacles.push(proj(c[0], ground(c[0], c[2]) + 1.05, c[2]));
  }
  for (const dy of [0, 0.35, 0.7]) obstacles.push(proj(summit[0], summit[1] + dy, summit[2]));

  let best: [number, number] = [summit[0] + 0.9, summit[2] + 1.0];
  let bestScore = -Infinity;
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    for (const r of [1.2, 1.6, 2.0, 2.5]) {
      const x = summit[0] + Math.cos(a) * r;
      const z = summit[2] + Math.sin(a) * r;
      let clear = Infinity;
      let off = 0;
      for (let i = 0; i < placed.length; i++) {
        for (let f = 0; f <= 1.0001; f += 0.2) {
          const w = LABEL_X + f * widths[i];
          for (const dy of [-0.07, 0.07]) {
            const [sx, sy] = proj(x + right.x * w, placed[i] + dy, z + right.z * w);
            if (Math.abs(sy) > 0.92 || sx > 1.6 * 0.95) off += 1;
            for (const o of obstacles) clear = Math.min(clear, Math.hypot(sx - o[0], sy - o[1]));
          }
        }
      }
      // the foot should be on revealed ground in front of the summit, not hidden behind it
      const facing = (Math.cos(a) * 0.667 + Math.sin(a) * 0.745) * 0.04;
      const score = Math.min(clear, 0.25) - off * 0.05 + facing - (r - 1.2) * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = [x, z];
      }
    }
  }
  return best;
}

/** Spread label heights so none overlap (1-D relaxation around their true heights). */
function spread(ys: number[], gap: number): number[] {
  const order = ys.map((y, i) => [y, i] as const).sort((p, q) => p[0] - q[0]);
  const out = order.map((o) => o[0]);
  for (let it = 0; it < 24; it++) {
    for (let i = 1; i < out.length; i++) {
      const d = out[i] - out[i - 1];
      if (d < gap) {
        const push = (gap - d) / 2;
        out[i] += push;
        out[i - 1] -= push;
      }
    }
  }
  const res = new Array<number>(ys.length);
  order.forEach((o, i) => (res[o[1]] = out[i]));
  return res;
}

const soundingVert = /* glsl */ `
varying float vY;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vY = w.y;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const soundingFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vY;
void main() {
  float f = fract(vY * 9.0);
  float fw = max(fwidth(vY * 9.0), 1e-4);
  float dash = smoothstep(0.0, fw, f) * (1.0 - smoothstep(0.45 - fw, 0.45, f));
  gl_FragColor = vec4(uColor, uOpacity * dash);
}
`;

type FadeText = Mesh & { fillOpacity: number; outlineOpacity: number };

/**
 * The locked test, once the run is finished: one cold beam sweeps across the summit, and a survey rod beside it carries
 * the real heights — CV (amber), select (bone), the locked test (ice) and the optimism gap between the last two.
 *
 * The rod stands on the ground (a cold survey mark at its foot). Scores the map never reached — a locked-test score
 * can sit below the ground the run mapped — continue below the foot as a dashed sounding line, drawn through the
 * ground on purpose (an instrument reading, not a stake). Labels sit screen-right on a soft dark halo with leader
 * ticks, spaced so none overlap, on the side away from the climb path; they fade in one after another.
 */
export const Truth = memo(function Truth({
  summit,
  bestY,
  selectY,
  testY,
  labels,
  climb,
  hidden = false,
}: {
  hidden?: boolean;
  summit: [number, number, number] | null;
  bestY: number | null;
  selectY: number | null;
  testY: number | null;
  labels: TruthLabels | null;
  climb: [number, number, number][];
}) {
  const { animate, field, u, scrub } = useSurvey();
  const on = summit != null && selectY != null && testY != null && bestY != null;
  const beam = useRef<Mesh>(null);
  const rod = useRef<Group>(null);
  const st = useRef({ op: 0, t0: null as number | null, onSince: null as number | null, label: [0, 0, 0, 0] });
  const texts = useRef<(FadeText | null)[]>([]);
  const leaders = useRef<(Mesh | null)[]>([]);

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
  const rodGeo = useMemo(() => {
    const g = new CylinderGeometry(0.014, 0.014, 1, 8, 1, true);
    g.translate(0, 0.5, 0);
    return g;
  }, []);
  const tickGeo = useMemo(() => new SphereGeometry(0.035, 16, 12), []);
  const gapGeo = useMemo(() => {
    const g = new CylinderGeometry(0.03, 0.03, 1, 12, 1, true);
    g.translate(0, 0.5, 0);
    return g;
  }, []);
  const leaderGeo = useMemo(() => {
    const g = new PlaneGeometry(1, 0.008);
    g.translate(0.5, 0, 0);
    return g;
  }, []);
  const m = useMemo(
    () => ({
      // above ground: a solid rod, depth-tested like the land it stands on
      rod: new MeshBasicMaterial({ color: new Color(SURVEY.contour).multiplyScalar(0.62), transparent: true, opacity: 0 }),
      // below ground: the sounding (x-ray, dashed)
      sound: new ShaderMaterial({
        uniforms: { uColor: { value: new Color(SURVEY.truth).multiplyScalar(0.7) }, uOpacity: { value: 0 } },
        vertexShader: soundingVert,
        fragmentShader: soundingFrag,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
      cv: new MeshBasicMaterial({ color: new Color(SURVEY.signal).multiplyScalar(3), transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }),
      select: new MeshBasicMaterial({ color: new Color(SURVEY.contour).multiplyScalar(1.2), transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
      test: new MeshBasicMaterial({ color: new Color(SURVEY.truth).multiplyScalar(3.2), transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }),
      gap: new MeshBasicMaterial({ color: new Color(SURVEY.truth).multiplyScalar(1.3), transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
      leader: new MeshBasicMaterial({ color: new Color(SURVEY.contour).multiplyScalar(0.8), transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: DoubleSide }),
    }),
    [],
  );
  useEffect(
    () => () => {
      [beamGeo, rodGeo, tickGeo, gapGeo, leaderGeo].forEach((g) => g.dispose());
      [beamMat, ...Object.values(m)].forEach((x) => x.dispose());
    },
    [beamGeo, rodGeo, tickGeo, gapGeo, leaderGeo, beamMat, m],
  );

  // Label order = reading order (and fade-in order): CV, select, locked test, gap.
  const g0 = on ? Math.min(selectY!, testY!) : 0;
  const g1 = on ? Math.max(selectY!, testY!) : 0;
  const marks = useMemo(() => (on ? [bestY!, selectY!, testY!, (g0 + g1) / 2] : [0, 0, 0, 0]), [on, bestY, selectY, testY, g0, g1]);
  const placed = useMemo(() => spread(marks, LABEL_GAP), [marks]);
  const texts4 = useMemo(() => (labels ? [labels.cv, labels.select, labels.test, labels.gap] : null), [labels]);
  const site = useMemo(
    () => (on ? rodSite(summit!, climb, marks, placed, (texts4 ?? ["", "", "", ""]).map((t) => t.length * CHAR_W), (x, z) => field.sample(x, z)) : null),
    [on, summit, climb, marks, placed, texts4, field],
  );
  const foot = site ? field.sample(site[0], site[1]) : 0;
  const tmpQ = useMemo(() => ({ q: new Quaternion(), v: new Vector3() }), []);

  useEffect(() => () => void u.uFoot.value.setW(0), [u]);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.05);
    const s = st.current;
    const now = state.clock.getElapsedTime();
    const gate = scrub?.current?.gates;
    // Landing: the truth section's own presence; run pages: on once the run is finished (hidden on the chart).
    s.op = gate ? (on ? gate.truth : 0) : damp(s.op, on && !hidden ? 1 : 0, animate ? 2 : 1e3, d);
    const a = s.op;
    if (a > 0.5 && s.onSince == null) s.onSince = now;
    if (a < 0.04) s.onSince = null;
    if (on && a > 0.5 && s.t0 == null) s.t0 = animate ? now + 0.2 : -100;
    if (a < 0.02) s.t0 = null;

    const B = beam.current;
    if (B && summit) {
      const t = s.t0 == null ? -1 : now - s.t0;
      const sweep = Math.min(1, Math.max(0, t / 2.8));
      const e = sweep * sweep * (3 - 2 * sweep);
      B.position.set(summit[0] - 7 + e * 9, 0, summit[2] - 1.5 + e * 2.5);
      const life = t < 0 ? 0 : Math.min(1, t / 0.4) * (1 - Math.min(1, Math.max(0, (t - 2.6) / 1.2)));
      beamMat.uniforms.uOpacity.value = life * 0.55 * a;
      B.visible = life * a > 0.002;
    }
    m.rod.opacity = a * 0.95;
    m.sound.uniforms.uOpacity.value = a * 0.55;
    m.cv.opacity = a;
    m.select.opacity = a;
    m.test.opacity = a;
    m.gap.opacity = a * 0.85;
    m.leader.opacity = a * 0.5;
    if (rod.current) rod.current.visible = a > 0.01;
    if (site) u.uFoot.value.set(site[0], site[1], 0.13, a);

    // labels: one after another once the section has arrived, each a short ease (reversible with the gate)
    const since = s.onSince == null ? -1 : now - s.onSince;
    for (let i = 0; i < 4; i++) {
      const want = since >= 0.15 + i * 0.16 ? 1 : 0;
      s.label[i] = animate ? damp(s.label[i], want, want ? 7 : 10, d) : want;
      const o = s.label[i] * a;
      const tx = texts.current[i];
      if (tx) {
        tx.fillOpacity = o * (i === 3 ? 0.75 : 0.96);
        tx.outlineOpacity = o * 0.85;
        tx.visible = o > 0.01;
        tx.position.x = LABEL_X + (1 - s.label[i]) * 0.06;
      }
      const ld = leaders.current[i];
      const lg = ld?.parent;
      if (ld && lg) {
        ld.visible = o > 0.01;
        // full billboard (crisp, upright type); the leader runs from the mark on the rod — expressed in the label's
        // camera-facing frame — to the start of the label
        lg.quaternion.copy(state.camera.quaternion);
        tmpQ.q.copy(state.camera.quaternion).invert();
        tmpQ.v.set(0, marks[i] - placed[i], 0).applyQuaternion(tmpQ.q);
        const x0 = tmpQ.v.x + 0.045;
        const y0 = tmpQ.v.y;
        const x1 = LABEL_X - 0.035;
        ld.position.set(x0, y0, 0);
        ld.rotation.set(0, 0, Math.atan2(-y0, x1 - x0));
        ld.scale.set(Math.max(0.001, Math.hypot(x1 - x0, y0)), 1, 1);
      }
    }
  });

  if (!on || !site) return null;
  const top = Math.max(bestY!, selectY!, testY!) + 0.4;
  const low = Math.min(selectY!, testY!, bestY!) - 0.25;
  const mats = [m.cv, m.select, m.test];
  const colors = [SURVEY.signal, SURVEY.contour, SURVEY.truth, SURVEY.truth];
  return (
    <group>
      <mesh ref={beam} geometry={beamGeo} material={beamMat} renderOrder={9} frustumCulled={false} />
      <group ref={rod} position={[site[0], 0, site[1]]}>
        {top > foot && <mesh renderOrder={4} geometry={rodGeo} material={m.rod} position={[0, foot, 0]} scale={[1, top - foot, 1]} />}
        {low < foot && <mesh renderOrder={20} geometry={rodGeo} material={m.sound} position={[0, low, 0]} scale={[1.4, foot - low, 1.4]} />}
        {mats.map((mat, i) => (
          <mesh key={i} renderOrder={21} geometry={tickGeo} material={mat} position={[0, marks[i], 0]} />
        ))}
        <mesh renderOrder={21} geometry={gapGeo} material={m.gap} position={[0, g0, 0]} scale={[1, Math.max(0.005, g1 - g0), 1]} />
        {texts4 && (
          <group>
            {texts4.map((t, i) => (
              <group key={i} position={[0, placed[i], 0]}>
                <mesh
                  ref={(el) => {
                    leaders.current[i] = el;
                  }}
                  renderOrder={22}
                  geometry={leaderGeo}
                  material={m.leader}
                />
                <Text
                  ref={(el: FadeText | null) => {
                    texts.current[i] = el;
                  }}
                  font={FONT_MONO}
                  position={[LABEL_X, 0, 0]}
                  fontSize={LABEL_FONT}
                  anchorX="left"
                  anchorY="middle"
                  color={colors[i]}
                  fillOpacity={0}
                  letterSpacing={0.03}
                  outlineWidth={0.022}
                  outlineBlur={0.05}
                  outlineColor={SURVEY.void}
                  outlineOpacity={0}
                  sdfGlyphSize={64}
                  material={XRAY_TEXT}
                  renderOrder={23}
                >
                  {t}
                </Text>
              </group>
            ))}
          </group>
        )}
      </group>
    </group>
  );
}, sameProps);

const XRAY_TEXT = new MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true });
