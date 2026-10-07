/**
 * Terra Incognita — the survey world. See docs/creative/02-direction.md (visual system + interaction model).
 *
 * A run is an expedition across an unknown fitness landscape:
 *   experiment         -> a probe that lands and reveals ground; probe height = real oriented CV mean
 *   probe (x, z)       -> deterministic map projection of the idea tree (bearing = idea category, step = change size)
 *   mapped surface     -> RBF interpolation through real probes; unrevealed ground fades into the void
 *   current best       -> a mercury bead; rolls uphill only when the gate keeps a probe
 *   discard / crash    -> dim survey stake on lower ground / collapsed crater of embers
 *   best cv.se         -> mist layer thickness (the noise floor)
 *   stop.saturation    -> cloud deck: appears only after `stopped`, settles at bestMean + saturation.value
 *   final scores       -> one "truth" beam sweep; select marker vs test marker; gap = optimism gap
 *
 * Playback state is owned by the caller: pass `view = buildView(events.slice(0, cursor), record)` and, for replays,
 * `domainView = buildView(allEvents, record)` so heights never rescale during playback.
 */

import type { RefObject } from "react";
import type { RunView } from "@/lib/run-state";

/**
 * Continuous, scroll-driven stage input (landing). Written by the page at frame rate into a ref; the frame loop reads
 * it, React never re-renders for it. Everything here is a pure function of the (lightly smoothed) scroll position.
 */
export interface SurveyScrub {
  /** Camera: pose `a` at progress `pa` blended toward pose `b` at progress `pb` by `w` (0 = all a). */
  a: SurveyPose;
  pa: number;
  b: SurveyPose;
  pb: number;
  w: number;
  /** 0 → 1 intro dolly from the orbit shot (time-driven once, after the loader). */
  intro: number;
  /** Continuous index along the full run's climb path (kept probes); null = rest on the current best. */
  beadT: number | null;
  /** Frame the subject off-centre (fractions of the viewport): +x moves it right, +y moves it up. */
  shiftX: number;
  shiftY: number;
  /**
   * Section moments (0..1 presence, eased by the page). The landing shows the complete run from the first frame, so
   * the mist, the cloud deck and the truth gauge cannot key off the run's phase there: they follow these instead.
   * Absent (run pages) = phase-driven.
   */
  gates?: SurveyGates;
}

export interface SurveyGates {
  /** The noise-floor mist (around the mist section). */
  mist: number;
  /** Cloud deck presence (the ceiling section; a thin cap after it, gone on the chart). */
  cloud: number;
  /** Cloud deck descent: 0 = high above, 1 = settled on the fitted ceiling. */
  cloudDrop: number;
  /** The locked-test gauge and beam (the truth section). */
  truth: number;
}

/** Authored camera states (landing scroll beats, run/gallery framings). */
export type SurveyPose =
  | "orbit" // the island as a speck in the void (loader / gate)
  | "approach" // hero: the plain with the headline lying on it
  | "first-probe" // ground level, e000 lands
  | "climb" // tracks the mercury bead along the climb (landing pinned section, live/simulate runs)
  | "mist" // low pass through the noise layer
  | "ceiling" // through the cloud deck, looking down
  | "truth" // the locked-test beam and the two markers
  | "chart" // top-down contour map (gallery thumbnails, landing outro)
  | "overview"; // run pages: three-quarter view of the whole survey

export interface SurveyCanvasProps {
  view: RunView;
  domainView?: RunView | null;
  pose?: SurveyPose;
  /** 0..1 progress within the current pose, for scroll-scrubbed camera moves on the landing. */
  poseProgress?: number;
  selectedId?: string | null;
  onSelect?: (expId: string) => void;
  /** "lite" = mobile / low GPU tier; "poster" = render a few frames then stop (thumbnails). */
  quality?: "full" | "lite" | "poster";
  /** Run pages: constrained drag-orbit + sonar selects probes. Landing: parallax only, sonar reveals labels. */
  interactive?: boolean;
  /** In-world SDF headline lying on the plain (landing hero / outro). */
  headline?: string | null;
  className?: string;
  ariaLabel?: string;
  /** Continuous scroll-driven camera + bead input (landing). Overrides `pose`/`poseProgress` for the camera. */
  scrub?: RefObject<SurveyScrub | null>;
  /** Called once when shaders are compiled and the first frame is on screen (loader gates). */
  onReady?: () => void;
}

/** Pure layout produced by lib/survey/layout.ts (no three.js imports; unit-tested). */
export interface SurveyProbe {
  id: string;
  parentId: string | null;
  index: number;
  status: RunView["experiments"][number]["status"];
  category: string;
  radical: boolean;
  /** World position of the probe on the ground; y = height from score (null score -> crater on parent ground). */
  pos: [number, number, number];
  score01: number | null;
  isBest: boolean;
  /** True if this probe was a keep (the bead visited it). */
  onClimbPath: boolean;
}

export interface SurveyLayout {
  probes: SurveyProbe[];
  /** Bead position (current best), null before the first scored probe. */
  bead: [number, number, number] | null;
  /** Ordered bead path through kept probes. */
  climb: [number, number, number][];
  /** World-space bounds of the mapped area (x/z min/max) for camera framing. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; maxY: number };
  /** Mist thickness (world units) from best cv.se. */
  mist: number;
  /** Cloud deck height; null until the run has stopped. */
  cloudY: number | null;
  selectY: number | null;
  testY: number | null;
  /** Height scale helpers. */
  heightOf: (orientedScore: number) => number;
}

export const SURVEY = {
  void: "#05070a",
  basaltLo: "#0d1117",
  basaltHi: "#1b222b",
  contour: "#d9d3c4",
  signal: "#ffb547",
  mist: "#7fd6d0",
  cloud: "#aab4c0",
  truth: "#eaf6ff",
  crash: "#ff5a3c",
} as const;
