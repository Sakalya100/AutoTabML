import type { SurveyGates, SurveyPose } from "@/lib/survey/contract";

/* ---- section moments (shared by the landing and the replay journey) ---- */

export const ramp = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The section moments for a reading line (page px): each one rises from the moment its own section (and its copy)
 * arrives — never before — and eases in over a short stretch of scroll. The land
 * is the complete run from the first frame, so nothing else holds them back) and eases out where the story moves on.
 * Pure in scroll, so scrolling back up plays them in reverse. Z = the camera blend half-width (px).
 */
export function gatesAt(geo: { pose: SurveyPose; start: number; end: number }[], line: number, Z: number, out: SurveyGates) {
  const at = (p: SurveyPose) => geo.find((g) => g.pose === p);
  const mist = at("mist");
  const ceil = at("ceiling");
  const truth = at("truth");
  const chart = at("chart");
  out.mist = mist ? ramp(mist.start, mist.start + Z * 1.2, line) * (1 - ramp(mist.end - Z * 0.3, mist.end + Z, line)) : 0;
  if (ceil) {
    const rise = ramp(ceil.start, ceil.start + Z * 0.8, line);
    // ceiling: full; the truth section: a thin cap over the summit; the top-down chart: clear
    const after = truth ? 1 - 0.72 * ramp(truth.start - Z, truth.start + Z, line) : 1;
    const gone = chart ? 1 - ramp(chart.start - Z, chart.start + Z * 0.5, line) : 1;
    out.cloud = rise * after * gone;
    // settles early in the section, so the camera's climb through the deck is one quick pass (not a long whiteout)
    out.cloudDrop = ramp(ceil.start, ceil.start + Z * 1.1, line);
  } else out.cloud = out.cloudDrop = 0;
  out.truth = truth ? ramp(truth.start, truth.start + Z * 0.8, line) * (1 - (chart ? ramp(chart.start - Z * 0.6, chart.start + Z * 0.4, line) : 0)) : 0;
}

