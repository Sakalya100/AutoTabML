import { describe, expect, it } from "vitest";
import {
  fmtCompact,
  fmtGap,
  fmtSpan,
  fmtUsd,
  greeting,
  honestyPoints,
  honestySentence,
  isEmptyDashboard,
  monotonePath,
  niceMax,
  normaliseSeries,
  parseDashboard,
  relTime,
  subline,
} from "@/lib/dashboard";
import { demoDashboard, emptyDashboard } from "@/lib/dashboard-fixture";

describe("parseDashboard", () => {
  it("fills a complete dashboard from nothing", () => {
    const d = parseDashboard(null);
    expect(d.summary.runs).toBe(0);
    expect(d.summary.successRate).toBeNull();
    expect(d.series).toEqual([]);
    expect(d.recentRuns).toEqual([]);
    expect(d.pricing).toEqual({ model: "gpt-oss-120b", provider: "Groq", input: 0.15, output: 0.6 });
    expect(isEmptyDashboard(d)).toBe(true);
  });

  it("coerces numeric strings, clamps rates and keeps nulls where the contract allows them", () => {
    const d = parseDashboard({
      summary: { runs: "12", experiments: 148.4, successRate: 1.4, keepRate: "0.25", medianOptimismGap: null, lastRunAt: "2026-10-09T10:00:00Z" },
    });
    expect(d.summary.runs).toBe(12);
    expect(d.summary.experiments).toBe(148);
    expect(d.summary.successRate).toBe(1);
    expect(d.summary.keepRate).toBe(0.25);
    expect(d.summary.medianOptimismGap).toBeNull();
    expect(d.summary.lastRunAt).toBe("2026-10-09T10:00:00Z");
  });

  it("orders recent runs newest first, caps them at 12 and reads hasModel strictly", () => {
    const runs = Array.from({ length: 15 }, (_, i) => ({
      id: `r${i}`,
      sessionId: `s${i}`,
      status: "finished",
      createdAt: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      hasModel: i % 2 ? true : "yes",
    }));
    const d = parseDashboard({ recentRuns: runs });
    expect(d.recentRuns).toHaveLength(12);
    expect(d.recentRuns[0].id).toBe("r14");
    expect(d.recentRuns[0].hasModel).toBe(false);
    expect(d.recentRuns[1].hasModel).toBe(true);
  });

  it("drops quality rows without both scores and derives a missing gap from the metric's direction", () => {
    const d = parseDashboard({
      quality: [
        { runId: "a", dataset: "x", metric: "roc_auc", cv: 0.9, test: 0.88 },
        { runId: "b", dataset: "y", metric: "rmse", cv: 10, test: 12 },
        { runId: "c", dataset: "z", metric: "rmse", cv: 10, test: null },
      ],
    });
    expect(d.quality.map((q) => q.runId)).toEqual(["a", "b"]);
    expect(d.quality[0].gap).toBeCloseTo(0.02);
    expect(d.quality[1].gap).toBeCloseTo(2);
  });

  it("sorts metrics and providers by weight and drops empty metrics", () => {
    const d = parseDashboard({
      metrics: [
        { metric: "rmse", runs: 1 },
        { metric: "roc_auc", runs: 4 },
        { metric: "mae", runs: 0 },
      ],
      providers: [
        { model: "a", calls: 3, tokens: 10 },
        { model: "b", calls: 1, tokens: 99 },
      ],
    });
    expect(d.metrics.map((m) => m.metric)).toEqual(["roc_auc", "rmse"]);
    expect(d.providers[0].model).toBe("b");
  });
});

describe("normaliseSeries", () => {
  it("sorts, sums duplicate days and zero-fills gaps", () => {
    const s = normaliseSeries([
      { date: "2026-10-03", runs: 1, experiments: 5 },
      { date: "2026-10-01", runs: 2, experiments: 9 },
      { date: "2026-10-03", runs: 1, experiments: 2 },
      { date: "garbage", runs: 9 },
    ]);
    expect(s.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(s[1]).toMatchObject({ runs: 0, experiments: 0 });
    expect(s[2]).toMatchObject({ runs: 2, experiments: 7 });
  });
});

describe("words and numbers", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  it("says how long ago", () => {
    expect(relTime("2026-10-09T11:59:40Z", now)).toBe("just now");
    expect(relTime("2026-10-09T11:48:00Z", now)).toBe("12m ago");
    expect(relTime("2026-10-09T10:00:00Z", now)).toBe("2h ago");
    expect(relTime("2026-10-06T12:00:00Z", now)).toBe("3d ago");
    expect(relTime(null, now)).toBe("—");
    expect(relTime("2026-10-09T11:00:20Z", now)).toBe("1h ago");
  });
  it("greets by the hour", () => {
    expect(greeting(8)).toBe("Good morning");
    expect(greeting(14)).toBe("Good afternoon");
    expect(greeting(21)).toBe("Good evening");
    expect(greeting(2)).toBe("Good evening");
  });
  it("formats compactly", () => {
    expect(fmtCompact(950)).toBe("950");
    expect(fmtCompact(12_400)).toBe("12.4k");
    expect(fmtCompact(3_210_000)).toBe("3.21M");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.0042)).toBe("$0.0042");
    expect(fmtUsd(1.234)).toBe("$1.23");
    expect(fmtSpan(42)).toBe("42s");
    expect(fmtSpan(750)).toBe("12m 30s");
    expect(fmtSpan(7300)).toBe("2h 01m");
    expect(fmtGap(0.0118)).toBe("+0.012");
    expect(fmtGap(-0.0004)).toBe("−0.0004");
    expect(fmtGap(0.00001)).toBe("0");
    expect(fmtGap(892.3)).toBe("+892.3");
  });
  it("writes the header line and the honesty sentence", () => {
    const d = demoDashboard(30);
    expect(subline({ ...d.summary, runs: 1, experiments: 12, lastRunAt: "2026-10-09T10:00:00Z" }, now)).toBe("1 run · 12 experiments · last run 2h ago");
    expect(honestySentence([])).toMatch(/No finished runs/);
    expect(honestySentence(d.quality)).toMatch(/of \d+ finished runs/);
  });
});

describe("charts", () => {
  it("draws a monotone curve that never overshoots a flat zero run", () => {
    const d = monotonePath([
      { x: 0, y: 100 },
      { x: 10, y: 100 },
      { x: 20, y: 0 },
      { x: 30, y: 100 },
    ]);
    expect(d.startsWith("M0,100C")).toBe(true);
    const ys = [...d.matchAll(/[\d.-]+,([\d.-]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(monotonePath([])).toBe("");
  });
  it("rounds axis maxima up", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(18)).toBe(20);
    expect(niceMax(21)).toBe(25);
    expect(niceMax(0.031)).toBeCloseTo(0.05);
  });
  it("keeps test = CV on the diagonal and puts 'test worse' below it for either metric direction", () => {
    const pts = honestyPoints([
      { runId: "a", dataset: "a", metric: "roc_auc", cv: 0.9, test: 0.88, gap: 0.02 },
      { runId: "b", dataset: "b", metric: "roc_auc", cv: 0.8, test: 0.8, gap: 0 },
      { runId: "c", dataset: "c", metric: "rmse", cv: 10, test: 12, gap: 2 },
    ]);
    for (const p of pts) {
      expect(p.u).toBeGreaterThan(0);
      expect(p.u).toBeLessThan(1);
      expect(p.v).toBeGreaterThan(0);
      expect(p.v).toBeLessThan(1);
    }
    expect(pts.find((p) => p.runId === "a")!.v).toBeLessThan(pts.find((p) => p.runId === "a")!.u);
    expect(pts.find((p) => p.runId === "b")!.v).toBeCloseTo(pts.find((p) => p.runId === "b")!.u);
    expect(pts.find((p) => p.runId === "c")!.v).toBeLessThan(pts.find((p) => p.runId === "c")!.u);
  });
});

describe("fixtures", () => {
  it("are stable and parse to themselves", () => {
    const a = demoDashboard(30);
    expect(demoDashboard(30)).toEqual(a);
    expect(a.series).toHaveLength(30);
    expect(parseDashboard(JSON.parse(JSON.stringify(a))).recentRuns).toHaveLength(a.recentRuns.length);
    expect(isEmptyDashboard(emptyDashboard(7))).toBe(true);
  });
});
