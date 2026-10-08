/**
 * Frontend feature flags (read by server components). AUTOTINKER_LIVE_RUNS=0 turns live runs off for a replays-only
 * demo; set it on both services, because the backend enforces it too.
 */
export function liveRunsEnabled(): boolean {
  return process.env.AUTOTINKER_LIVE_RUNS !== "0";
}
