import { describe, expect, it } from "vitest";
import { fmtBytes, mergeFiles, parseAssetsEvent, parseAssetsListing, parseChart, thin } from "@/lib/assets";
import { coerceEvent } from "@/lib/events";

const ASSETS_EVENT = {
  type: "assets_ready",
  run_id: "r-x",
  seq: 40,
  ts: "2026-10-08T10:01:00Z",
  charts: [
    {
      id: "roc",
      title: "ROC curve",
      kind: "curve",
      x_label: "False positive rate",
      y_label: "True positive rate",
      series: [
        {
          name: "AUC 0.873",
          points: [
            [0, 0],
            [0.1, 0.5],
            [1, 1],
          ],
        },
      ],
      diagonal: true,
    },
    {
      id: "confusion",
      title: "Confusion matrix",
      kind: "matrix",
      labels: ["No", "Yes"],
      matrix: [
        [90, 10],
        [15, 64],
      ],
    },
    { id: "radar", title: "Something new", kind: "radar", values: [1, 2, 3] },
    { id: "bad", title: "Malformed", kind: "matrix", labels: ["a"], matrix: [[1, 2]] },
    {
      id: "residuals",
      title: "Residuals",
      kind: "histogram",
      x_label: "Actual − predicted",
      bins: [
        { x0: -1, x1: 0, count: 3 },
        { x0: 0, x1: 1, count: 5 },
      ],
    },
  ],
  files: [
    { name: "model.joblib", path: "assets/model.joblib", bytes: 12345, kind: "model", content_type: "application/octet-stream" },
    { name: "pipeline.py", path: "assets/pipeline.py", bytes: 2345, kind: "code", content_type: "text/x-python" },
  ],
};

describe("assets", () => {
  it("coerces the assets_ready event", () => {
    expect(coerceEvent(ASSETS_EVENT)?.type).toBe("assets_ready");
    expect(coerceEvent({ ...ASSETS_EVENT, charts: "nope" })).toBeNull();
  });

  it("keeps known charts, skips unknown kinds and malformed ones", () => {
    const { charts, files } = parseAssetsEvent(ASSETS_EVENT);
    expect(charts.map((c) => c.id)).toEqual(["roc", "confusion", "residuals"]);
    expect(charts[0]).toMatchObject({ kind: "curve", xLabel: "False positive rate", diagonal: true });
    expect(files.map((f) => [f.name, f.kind, f.available])).toEqual([
      ["model.joblib", "model", false],
      ["pipeline.py", "code", false],
    ]);
  });

  it("drops non-finite points and caps huge scatters", () => {
    const c = parseChart({
      kind: "scatter",
      points: [
        [1, 2],
        [Number.NaN, 1],
        ["a", 2],
        [3, 4],
      ],
    });
    expect(c?.kind === "scatter" && c.points).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(thin([...Array(10).keys()], 4)).toEqual([0, 3, 6, 9]);
    expect(parseChart({ kind: "curve", series: [{ points: [[0, 0]] }] })).toBeNull();
  });

  it("merges the API listing over the event's files; unavailable or missing reads as preparing", () => {
    const { files } = parseAssetsEvent(ASSETS_EVENT);
    const listing = parseAssetsListing({
      files: [
        {
          name: "model.joblib",
          kind: "model",
          bytes: 12400,
          contentType: "application/octet-stream",
          downloadUrl: "/api/runs/r-x/assets/model.joblib",
          available: true,
          note: null,
        },
        {
          name: "pipeline.py",
          kind: "code",
          bytes: 2345,
          contentType: "text/x-python",
          downloadUrl: "/api/runs/r-x/assets/pipeline.py",
          available: false,
          note: "uploading",
        },
        { name: "extra.csv", kind: "data", bytes: 10, downloadUrl: "/x", available: true },
      ],
    });
    const merged = mergeFiles(files, listing);
    expect(merged.map((f) => [f.name, f.available, f.bytes])).toEqual([
      ["model.joblib", true, 12400],
      ["pipeline.py", false, 2345],
      ["extra.csv", true, 10],
    ]);
    expect(mergeFiles(files, parseAssetsListing({ error: "not found" })).every((f) => !f.available)).toBe(true);
    expect(parseAssetsListing(null)).toEqual([]);
  });

  it("formats sizes", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(12345)).toBe("12 KB");
    expect(fmtBytes(2345)).toBe("2.3 KB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
