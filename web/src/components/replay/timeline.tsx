"use client";

/*
 * The run, idea by idea, as one scrubbable strip along the bottom of the world. Each mark is one experiment; its
 * height is that experiment's score (the same height it has on the map), amber where it was kept, ember where it
 * broke. Drag, click, or use the arrow keys: the playhead moves continuously and the stage rolls the ball with it.
 */

import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { RunView } from "@/lib/run-state";
import { plainIdea } from "@/lib/story";

interface Props {
  view: RunView;
  /** Experiment under the playhead, or null in the summary (playhead hidden). */
  at: number | null;
  /** Continuous position; `settle` = the gesture ended (snap to the nearest idea). */
  onScrub: (t: number, settle: boolean) => void;
  hint: boolean;
}

export function Timeline({ view, at, onScrub, hint }: Props) {
  const exps = view.experiments;
  const n = exps.length;
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const heights = useMemo(() => {
    const s = exps.map((x) => x.cv?.mean ?? null);
    const v = s.filter((x): x is number => x != null);
    if (!v.length) return s.map(() => 0.2);
    // A robust floor: one bad idea far below shouldn't flatten everything else.
    const sorted = [...v].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.1)];
    const hi = sorted[sorted.length - 1];
    const span = Math.max(1e-9, hi - lo);
    return s.map((x) => (x == null ? 0 : 0.14 + 0.86 * Math.min(1, Math.max(0, (x - lo) / span))));
  }, [exps]);

  if (n === 0) return null;
  const tAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const u = (clientX - r.left) / Math.max(1, r.width);
    return u * n - 0.5;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = tAt(e.clientX);
    setDrag(t);
    onScrub(t, false);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (drag == null) return;
    const t = Math.min(n - 1, Math.max(0, tAt(e.clientX)));
    setDrag(t);
    onScrub(t, false);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (drag == null) return;
    const t = Math.min(n - 1, Math.max(0, tAt(e.clientX)));
    setDrag(null);
    onScrub(t, true);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = at ?? exps.find((x) => x.id === view.bestId)?.index ?? 0;
    const step: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 5, PageDown: -5 };
    let next: number | null = null;
    if (e.key in step) next = (at == null ? cur : cur + step[e.key]);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next == null) return;
    e.preventDefault();
    onScrub(Math.min(n - 1, Math.max(0, next)), true);
  };

  const head = drag ?? at;
  const cur = at != null ? exps[at] : null;
  const pct = head != null ? ((Math.min(n - 1, Math.max(0, head)) + 0.5) / n) * 100 : 0;

  return (
    <div className="rp-timeline" data-dragging={drag != null ? "" : undefined}>
      <div className="rp-tl-head" aria-hidden>
        {hint ? (
          <>
            <span>Every idea, in order. Drag to replay the climb.</span>
            <span className="rp-tl-legend">
              <i data-k="keep" /> kept <i data-k="discard" /> dropped
            </span>
          </>
        ) : (
          <>
            <span>
              {exps[0]?.id} <span className="rp-tl-arrow">→</span> {exps[n - 1]?.id}
            </span>
            <span>← → to step · Esc for the summary</span>
          </>
        )}
      </div>
      <div
        ref={track}
        className="rp-tl-track"
        role="slider"
        tabIndex={0}
        aria-label="Replay the run, idea by idea"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={(at ?? 0) + 1}
        aria-valuetext={cur ? `Idea ${at! + 1} of ${n}: ${plainIdea(cur.idea)}, ${cur.status === "keep" ? "kept" : cur.status === "crash" ? "crashed" : "dropped"}` : "Summary"}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      >
        {exps.map((x, i) => (
          <span key={x.id} className="rp-tl-bar" data-k={x.status} data-on={at === i ? "" : undefined} style={{ "--h": heights[i] } as React.CSSProperties} />
        ))}
        {head != null && <span className="rp-tl-head-line" style={{ left: `${pct}%` }} aria-hidden />}
      </div>
    </div>
  );
}
