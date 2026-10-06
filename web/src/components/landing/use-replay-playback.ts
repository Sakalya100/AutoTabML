"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnyEvent } from "@/lib/events";
import { buildView, type RunView } from "@/lib/run-state";
import type { RunRecord } from "@/lib/schema";

export interface PlaybackOptions {
  /** 1 = the HeroReplay pacing (140 ms per event, 380 ms on decisions). */
  speed?: number;
  /** Loop the whole run when no target is set. */
  loop?: boolean;
  /** Seek to this cursor (events.slice(0, target)) and hold. null = free play / loop. */
  target?: number | null;
  /** Reduced motion: no autoplay — jump straight to the target (or the finished run). */
  reduced?: boolean;
}

/**
 * Looping, seekable replay of a recorded run. The view is always buildView(events.slice(0, cursor), record),
 * the same reducer the replay page and live runs use, so every number on screen is the run's own.
 */
export function useReplayPlayback(events: readonly AnyEvent[], record: RunRecord | null, opts: PlaybackOptions = {}) {
  const { speed = 1, loop = true, target = null, reduced = false } = opts;
  const end = events.length;
  const [cursor, setCursor] = useState(() => (reduced ? (target ?? end) : Math.min(1, end)));

  useEffect(() => {
    if (reduced) {
      const t = setTimeout(() => setCursor(target ?? end), 0);
      return () => clearTimeout(t);
    }
    if (target != null) {
      if (cursor === target) return;
      // Seek: ease toward the target (big jumps first, single events at the end) in well under a second.
      const dist = target - cursor;
      const step = Math.sign(dist) * Math.max(1, Math.ceil(Math.abs(dist) / 6));
      const t = setTimeout(() => setCursor((c) => (Math.abs(target - c) <= Math.abs(step) ? target : c + step)), 45);
      return () => clearTimeout(t);
    }
    const atEnd = cursor >= end;
    if (atEnd && !loop) return;
    const next = events[cursor];
    const base = atEnd ? 4200 : next?.type === "decision" ? 380 : next?.type === "stopped" || next?.type === "run_finished" ? 1400 : 140;
    const t = setTimeout(() => setCursor((c) => (c >= end ? 1 : c + 1)), base / Math.max(0.1, speed));
    return () => clearTimeout(t);
  }, [cursor, end, events, loop, reduced, speed, target]);

  const view: RunView = useMemo(() => buildView(events.slice(0, cursor), record), [events, cursor, record]);
  return { view, cursor, end, setCursor };
}
