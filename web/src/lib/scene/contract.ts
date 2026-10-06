/**
 * The living reef — shared contract between the 3D scene (components/reef/*) and the pages that use it.
 *
 * Metaphor: a run grows a bioluminescent coral from the dark seabed toward the light at the surface.
 * Every visual is driven by real RunView fields; nothing is decorative-only:
 *
 *   experiment            -> a branch sprouting from its real parent (ExpView.parentId)
 *   oriented CV mean      -> branch tip height (normalised over the run's kept-score range)
 *   keep                  -> glows, thickens, keeps growing
 *   discard               -> a short upward side-shoot on the parent's stem that withers into drifting particles
 *   crash                 -> spark burst, no branch
 *   best's cv.se          -> translucent halo around the best tip (the noise band)
 *   stop.saturation       -> the water surface: hazy and far until `stopped`, then settles at
 *                            bestMean + saturation.value (the fitted asymptote) — fallback bestMean + se
 *   final.test_score      -> a sealed shell on the seabed; opens only at `finished`, the pearl rises to the
 *                            test height; the vertical gap pearl <-> select marker is the optimism gap
 *   profile.columns       -> nutrient streams drifting in during `intro`/`nutrients` (colour by ColumnKind)
 *
 * Playback/selection state is NOT owned by the scene: callers pass the RunView produced by
 * `buildView(events.slice(0, cursor), record)` from lib/run-state.ts, so the 2D chart, ledger and the reef
 * always agree.
 */

import type { RunView } from "@/lib/run-state";

export type SceneChapter =
  | "overview" // default: whole reef, gentle orbit
  | "intro" // hero: camera low in the abyss looking up at the light
  | "nutrients" // the data profile drifting in
  | "mutation" // close on the growing tip / current experiment
  | "selection" // kept vs withered branches, the noise halo
  | "ceiling" // camera rises to the surface
  | "test"; // down to the shell and the pearl

export interface ReefSceneProps {
  view: RunView;
  selectedId?: string | null;
  onSelect?: (expId: string) => void;
  chapter?: SceneChapter;
  /** "lite" for thumbnails/mobile: no postprocessing, fewer particles. */
  quality?: "full" | "lite";
  /** Hover/click picking and orbit controls. Off for the landing hero background. */
  interactive?: boolean;
  /** Slow idle camera drift. */
  autoRotate?: boolean;
  className?: string;
}

/** Pure, deterministic geometry for a RunView (lib/scene/layout.ts). Unit-tested; no three.js imports. */
export interface ReefNode {
  id: string;
  parentId: string | null;
  index: number;
  status: RunView["experiments"][number]["status"];
  radical: boolean;
  /** World position of the branch tip. y = height from score. */
  tip: [number, number, number];
  /** Branch base: kept branches start at the parent's tip (roots on the seabed); side-shoots (discard/crash/running)
   *  attach along the parent's stem — see branchControls/pointOnBranch in layout.ts. */
  base: [number, number, number];
  /** 0..1 score within the run's range (null for crash/running without a score). */
  score01: number | null;
  isBest: boolean;
}

export interface ReefLayout {
  nodes: ReefNode[];
  seabedY: number;
  /** Surface (ceiling) height; null until the run has stopped. */
  surfaceY: number | null;
  /** Noise halo radius (world units) around the best tip, from best's cv.se. */
  haloRadius: number;
  bestId: string | null;
  /** Height of the select score marker and the test pearl (null until finished). */
  selectY: number | null;
  testY: number | null;
}

/** Scene palette (always rendered on a dark abyss background, independent of the site theme). */
export const REEF = {
  abyss: "#03060d",
  deep: "#071a2b",
  surfaceLight: "#bff6ff",
  keep: "#4ff5d2", // bioluminescent cyan-green
  best: "#ffd27a", // sunlit gold for the best lineage
  discard: "#7f7aa8", // ashen violet
  crash: "#ff5a4e", // coral red sparks
  halo: "#7ad7ff",
  pearl: "#f4f1ff",
  nutrient: { numeric: "#5ab8ff", categorical: "#c08bff", boolean: "#7af0a8", datetime: "#ffb36b", text: "#ff8ac8", id: "#55606f", constant: "#3b4350" },
} as const;
