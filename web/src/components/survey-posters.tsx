"use client";

/**
 * Gallery thumbnails without one live WebGL context per card: posters are rendered one at a time by a single
 * <SurveyCanvas quality="poster" pose="chart">, captured to an image on its first ready frame, cached for the
 * session, and the canvas is unmounted before the next card renders. If no capture succeeds, that card keeps its
 * poster canvas, which renders a few frames and then stops.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useWebGLAvailable } from "@/lib/gl";
import type { RunView } from "@/lib/run-state";
import { SurveyCanvas, SurveySkeleton } from "./survey-source";

const GIVE_UP_MS = 8000;
const STORE = "survey-poster:";

const noop = () => () => {};
const memory = new Map<string, string>();
function cached(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const v = sessionStorage.getItem(STORE + key);
    if (v) memory.set(key, v);
    return v;
  } catch {
    return null;
  }
}
function remember(key: string, url: string) {
  memory.set(key, url);
  try {
    sessionStorage.setItem(STORE + key, url);
  } catch {}
}

/** True if the image has real content (anything noticeably brighter than the void). */
function hasContent(canvas: HTMLCanvasElement): boolean {
  try {
    const probe = document.createElement("canvas");
    probe.width = 24;
    probe.height = 15;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const px = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 60 && px[i + 3] > 0) lit++;
    return lit >= 3;
  } catch {
    return false;
  }
}

interface Queue {
  register: (key: string) => void;
  active: string | null;
  done: (key: string, outcome: "image" | "live") => void;
}
const Ctx = createContext<Queue | null>(null);

export function PosterQueue({ children }: { children: ReactNode }) {
  const [order, setOrder] = useState<string[]>([]);
  const [settled, setSettled] = useState<Record<string, true>>({});
  const register = useCallback((key: string) => setOrder((o) => (o.includes(key) ? o : [...o, key])), []);
  const done = useCallback((key: string) => setSettled((s) => (s[key] ? s : { ...s, [key]: true })), []);
  const active = order.find((k) => !settled[k] && !cached(k)) ?? null;
  const value = useMemo(() => ({ register, active, done }), [register, active, done]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function SurveyPoster({ cacheKey, view, label, className = "" }: { cacheKey: string; view: RunView; label: string; className?: string }) {
  const queue = useContext(Ctx);
  const webgl = useWebGLAvailable();
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const [captured, setImg] = useState<string | null>(null);
  const img = captured ?? (hydrated ? cached(cacheKey) : null);
  const [live, setLive] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cached(cacheKey)) queue?.register(cacheKey);
  }, [cacheKey, queue]);

  const rendering = !img && (live || queue?.active === cacheKey);

  const finish = useCallback(
    (url: string | null) => {
      if (url) {
        remember(cacheKey, url);
        setImg(url);
        queue?.done(cacheKey, "image");
      } else {
        setLive(true); // keep this card's poster canvas; it renders a few frames and then stops on its own
        queue?.done(cacheKey, "live");
      }
    },
    [cacheKey, queue],
  );

  // The world reports its first real frame from inside the frame loop, before that frame is drawn. A microtask runs
  // after the draw but before the browser presents it, while the drawing buffer still holds the image.
  const settled = useRef(false);
  const onReady = useCallback(() => {
    queueMicrotask(() => {
      if (settled.current) return;
      const canvas = host.current?.querySelector("canvas");
      if (!canvas || !hasContent(canvas)) return;
      settled.current = true;
      let url: string | null = null;
      try {
        url = canvas.toDataURL("image/webp", 0.86);
      } catch {}
      finish(url);
    });
  }, [finish]);

  // If the world never reports a drawable frame, give the slot to the next card.
  useEffect(() => {
    if (!rendering || live) return;
    settled.current = false;
    const t = setTimeout(() => {
      if (settled.current) return;
      settled.current = true;
      finish(null);
    }, GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [rendering, live, finish]);

  return (
    <div role="img" aria-label={label} className={`overflow-hidden bg-[#05070a] ${className}`}>
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element -- a session-cached data URL rendered on the client
        <img src={img} alt="" className="poster-in absolute inset-0 size-full object-cover" draggable={false} />
      ) : rendering && webgl ? (
        <div ref={host} className="absolute inset-0">
          <SurveyCanvas view={view} pose="chart" quality="poster" interactive={false} className="absolute inset-0" ariaLabel={label} onReady={onReady} />
        </div>
      ) : (
        <SurveySkeleton />
      )}
    </div>
  );
}
