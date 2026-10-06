"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  /** Scroll scrubbing: seek straight to the target both ways (the reef staggers births / retracts itself). */
  jump?: boolean;
}

/**
 * Looping, seekable replay of a recorded run. The view is always buildView(events.slice(0, cursor), record),
 * the same reducer the replay page and live runs use, so every number on screen is the run's own.
 */
export function useReplayPlayback(events: readonly AnyEvent[], record: RunRecord | null, opts: PlaybackOptions = {}) {
  const { speed = 1, loop = true, target = null, reduced = false, jump = false } = opts;
  const end = events.length;
  const [cursor, setCursor] = useState(() => (reduced ? (target ?? end) : Math.min(1, end)));
  // After a loop restart the old reef needs a beat to dissolve before the baseline sprouts again.
  const looped = useRef(false);

  useEffect(() => {
    if (reduced) {
      const t = setTimeout(() => setCursor(target ?? end), 0);
      return () => clearTimeout(t);
    }
    if (target != null) {
      if (cursor === target) return;
      if (target < cursor || jump) {
        // Seeking back (or scrubbing): jump. The reef retracts and dissolves the removed branches itself (newest first).
        const t = setTimeout(() => setCursor(target), 0);
        return () => clearTimeout(t);
      }
      // Seeking forward: one whole experiment per beat, so the reef grows them in sequence (it staggers births)
      // instead of twenty branches popping in at once.
      let next = cursor + 1;
      while (next < target && events[next - 1]?.type !== "decision") next++;
      const t = setTimeout(() => setCursor(Math.min(target, next)), 110);
      return () => clearTimeout(t);
    }
    const atEnd = cursor >= end;
    if (atEnd && !loop) return;
    const next = events[cursor];
    // Loop: hold the finished reef, rewind to an empty seabed (the reef dissolves), and let it settle for a beat
    // before the baseline sprouts again — a crossfade, never a hard reset.
    const base = atEnd ? 4200 : cursor <= 1 ? (looped.current ? 2400 : 900) : next?.type === "decision" ? 380 : next?.type === "stopped" || next?.type === "run_finished" ? 1400 : 140;
    const t = setTimeout(() => {
      if (atEnd) looped.current = true;
      setCursor((c) => (c >= end ? 1 : c + 1));
    }, base / Math.max(0.1, speed));
    return () => clearTimeout(t);
  }, [cursor, end, events, jump, loop, reduced, speed, target]);

  const view: RunView = useMemo(() => buildView(events.slice(0, cursor), record), [events, cursor, record]);
  return { view, cursor, end, setCursor };
}
