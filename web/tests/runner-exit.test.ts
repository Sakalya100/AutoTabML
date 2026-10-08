import { describe, expect, it } from "vitest";
import { exitPatch } from "@/lib/runner/local";
import { isTerminal } from "@/lib/store";

describe("local runner: final status", () => {
  it("a Stop/cancel that lands after a clean finish keeps the run finished", () => {
    expect(exitPatch({ code: 0, signal: null, cancelled: true, hasRunJson: true }).status).toBe("finished");
  });
  it("a real cancel mid-run is cancelled", () => {
    expect(exitPatch({ code: null, signal: "SIGTERM", cancelled: true, hasRunJson: false }).status).toBe("cancelled");
    expect(exitPatch({ code: 0, signal: null, cancelled: true, hasRunJson: false }).status).toBe("cancelled");
  });
  it("agents giving up early still counts as finished when the report exists", () => {
    expect(exitPatch({ code: 3, signal: null, cancelled: false, hasRunJson: true }).status).toBe("finished");
    expect(exitPatch({ code: 3, signal: null, cancelled: false, hasRunJson: false }).status).toBe("failed");
  });
  it("crashes and spawn errors fail", () => {
    expect(exitPatch({ code: 1, signal: null, cancelled: false, hasRunJson: false }).status).toBe("failed");
    expect(exitPatch({ code: null, signal: null, cancelled: false, hasRunJson: false, spawnError: new Error("ENOENT") }).status).toBe("failed");
  });
  it("finished/cancelled/failed are terminal, so Stop and steer are refused after them", () => {
    for (const s of ["finished", "cancelled", "failed"] as const) expect(isTerminal(s)).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });
});
