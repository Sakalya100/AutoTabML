"use client";

import { Billboard, Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { memo, useRef, useState } from "react";
import type { Group, Mesh } from "three";
import { SURVEY, type SurveyProbe } from "@/lib/survey/contract";
import { damp, FONT_MONO, FONT_SERIF, FONT_SERIF_ITALIC, sameProps, useSurvey } from "./shared";

type TroikaText = Mesh & { fillOpacity: number; outlineOpacity: number };

/**
 * The headline lies on the plain like an engraving: SDF text in Instrument Serif (the DOM display face), depth-tested
 * so the mapped ridges can occlude it. Like the DOM headline, the last word is set in italic, in signal amber.
 *
 * Seen from a camera ~30° above the plain, flat type foreshortens into something squat and heavy. The type is
 * stretched along its depth axis by 1/sin(elevation) — the road-marking trick — so its proportions read true from
 * wherever the camera is (and it is untouched from straight above). A new line crossfades (out, swap, in).
 */
export const Headline = memo(function Headline({ text, at, size, width, stacked = false }: { text: string | null; at: [number, number, number]; size: number; width: number; stacked?: boolean }) {
  const { animate } = useSurvey();
  const lead = useRef<TroikaText>(null);
  const tail = useRef<TroikaText>(null);
  const plate = useRef<Group>(null);
  const [shown, setShown] = useState(text);
  const op = useRef(0);
  const st = useRef({ wLead: 0, wTail: 0, k: 1 });
  const words = (shown ?? "").trim().split(/\s+/);
  const tailWord = words.length > 1 ? words[words.length - 1] : "";
  const leadText = words.length > 1 ? words.slice(0, -1).join(" ") : (shown ?? "");
  const measure = (which: "wLead" | "wTail") => (m: Mesh) => {
    const bb = (m as unknown as { textRenderInfo?: { blockBounds: number[] } }).textRenderInfo?.blockBounds;
    if (bb) st.current[which] = bb[2] - bb[0];
  };
  useFrame((state, dt) => {
    const d = Math.min(dt, 0.05);
    const want = text === shown && text ? 1 : 0;
    op.current = damp(op.current, want, animate ? (want ? 1.6 : 5) : 1e3, d);
    if (text !== shown && op.current < 0.02) setShown(text);
    const o = op.current;
    const s = st.current;
    const gap = size * 0.26;
    // inline: "lead tail" centred; stacked (portrait): lead over tail, both centred
    const total = stacked ? Math.max(s.wLead, s.wTail) : s.wLead + (s.wTail ? gap + s.wTail : 0);
    const fit = total > 0 ? Math.min(1, width / total) : 1;
    if (lead.current) {
      lead.current.fillOpacity = o * 0.94;
      lead.current.visible = o > 0.005 && s.wLead > 0;
      lead.current.position.set(stacked ? -s.wLead / 2 : -total / 2, stacked && s.wTail ? size * 0.5 : 0, 0);
    }
    if (tail.current) {
      tail.current.fillOpacity = o;
      tail.current.visible = o > 0.005 && s.wTail > 0;
      tail.current.position.set(stacked ? -s.wTail / 2 : -total / 2 + s.wLead + gap, stacked ? -size * 0.5 : 0, 0);
    }
    const g = plate.current;
    if (g) {
      const c = state.camera.position;
      const elev = Math.atan2(Math.max(0.01, c.y - at[1]), Math.hypot(c.x - at[0], c.z - at[2]));
      const k = Math.min(1.9, Math.max(1, 1 / Math.max(0.2, Math.sin(elev))));
      s.k = animate ? damp(s.k, k, 4, d) : k;
      g.scale.set(fit, fit * s.k, 1);
    }
  });
  if (!shown) return null;
  return (
    <group position={at} rotation={[-Math.PI / 2, 0, 0]}>
      <group ref={plate}>
        <Text
          ref={lead}
          font={FONT_SERIF}
          fontSize={size}
          anchorX="left"
          anchorY="middle"
          letterSpacing={-0.01}
          color={SURVEY.contour}
          fillOpacity={0}
          sdfGlyphSize={128}
          renderOrder={1}
          onSync={measure("wLead")}
        >
          {leadText}
        </Text>
        {tailWord ? (
          <Text
            ref={tail}
            font={FONT_SERIF_ITALIC}
            fontSize={size}
            anchorX="left"
            anchorY="middle"
            letterSpacing={-0.01}
            color={SURVEY.signal}
            fillOpacity={0}
            sdfGlyphSize={128}
            renderOrder={1}
            onSync={measure("wTail")}
          >
            {tailWord}
          </Text>
        ) : null}
      </group>
    </group>
  );
}, sameProps);

export interface ProbeLabel {
  id: string;
  line1: string;
  line2: string;
}

/**
 * In-world mono labels pinned on probes: shown when a sonar ring crosses a probe (fade after ~3 s), and always on the
 * selected one. Pre-created per probe (opacity 0), never created or destroyed by the sonar.
 */
export function ProbeLabels({ probes, labels, hits, selectedId }: { probes: SurveyProbe[]; labels: Map<string, ProbeLabel>; hits: Map<string, number>; selectedId: string | null }) {
  return (
    <group>
      {probes.map((p) => {
        const l = labels.get(p.id);
        return l ? <ProbeTag key={p.id} probe={p} label={l} hits={hits} selected={p.id === selectedId} /> : null;
      })}
    </group>
  );
}

const ProbeTag = memo(function ProbeTag({ probe, label, hits, selected }: { probe: SurveyProbe; label: ProbeLabel; hits: Map<string, number>; selected: boolean }) {
  const { field } = useSurvey();
  const a = useRef<TroikaText>(null);
  const b = useRef<TroikaText>(null);
  const g = useRef<Mesh>(null);
  const op = useRef(0);
  useFrame((state, dt) => {
    const now = state.clock.getElapsedTime();
    const hit = hits.get(probe.id);
    const age = hit == null ? 1e9 : now - hit;
    const want = selected ? 1 : age < 0 ? 0 : age < 1.1 ? 1 : 0;
    op.current = damp(op.current, want, want ? 9 : 2.2, Math.min(dt, 0.05));
    const o = op.current;
    if (a.current) {
      a.current.fillOpacity = o;
      a.current.visible = o > 0.01;
    }
    if (b.current) {
      b.current.fillOpacity = o * 0.6;
      b.current.visible = selected && o > 0.01;
    }
    if (g.current) {
      const top = probe.status === "keep" ? 1.05 : probe.status === "crash" ? 0.3 : 0.55;
      g.current.position.set(probe.pos[0], field.sample(probe.pos[0], probe.pos[2]) + top + 0.18 + (1 - o) * 0.08, probe.pos[2]);
      // Constant on-screen size (~9.5 px) at any camera distance.
      const dist = state.camera.position.distanceTo(g.current.position);
      const fov = (state.camera as unknown as { fov?: number }).fov ?? 34;
      g.current.scale.setScalar(Math.max(0.35, (dist * Math.tan((fov * Math.PI) / 360) * 2 * 9.5) / (state.size.height * 0.12)));
    }
  });
  const accent = probe.status === "keep" ? SURVEY.signal : probe.status === "crash" ? SURVEY.crash : SURVEY.contour;
  return (
    <Billboard ref={g as never}>
      <Text ref={a} font={FONT_MONO} fontSize={0.12} anchorX="center" anchorY="bottom" color={accent} fillOpacity={0} letterSpacing={0.02} renderOrder={12}>
        {label.line1}
      </Text>
      <Text ref={b} font={FONT_MONO} fontSize={0.085} position={[0, -0.02, 0]} anchorX="center" anchorY="top" color={SURVEY.contour} fillOpacity={0} letterSpacing={0.04} renderOrder={12}>
        {label.line2}
      </Text>
    </Billboard>
  );
}, (a, b) =>
  a.selected === b.selected &&
  a.hits === b.hits &&
  a.label.line1 === b.label.line1 &&
  a.label.line2 === b.label.line2 &&
  a.probe.id === b.probe.id &&
  a.probe.status === b.probe.status &&
  a.probe.pos[0] === b.probe.pos[0] &&
  a.probe.pos[2] === b.probe.pos[2]);
