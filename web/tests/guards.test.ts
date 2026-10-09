import { describe, expect, it } from "vitest";
import { parseTable, type ColumnStats } from "@/lib/ingest/csv";
import { estimateSeconds, estimateText, etaText, liveEtaSeconds, setupWarnings, targetBlock } from "@/lib/ingest/guards";
import { allowedSuggestion, suggest, suggestionFor } from "@/lib/ingest/suggest";

const titanicHead = [
  "PassengerId,Survived,Pclass,Name,Sex,Age,Ticket,Cabin",
  ...Array.from(
    { length: 120 },
    (_, i) =>
      `${i + 1},${i % 3 === 0 ? 1 : 0},${(i % 3) + 1},"Surname${i}, Mr. Given${i} Middle${i * 7}",${i % 2 ? "male" : "female"},${20 + (i % 40)},A/${1000 + i},${i % 5 ? "" : `C${i}`}`,
  ),
].join("\n");

describe("targetBlock", () => {
  const t = parseTable(titanicHead);
  const by = (n: string) => t.stats.find((s) => s.name === n);
  it("blocks IDs, free text and mostly-empty columns, with a short reason", () => {
    expect(targetBlock(by("PassengerId"))).toBe("ID column — every row is different");
    expect(targetBlock(by("Name"))).toBe("Free text — almost every value is different");
    expect(targetBlock(by("Cabin"))).toMatch(/^Mostly missing — 80% of rows are empty$/);
    expect(targetBlock(by("Survived"))).toBeNull();
    expect(targetBlock(by("Sex"))).toBeNull();
  });
  it("blocks constant and empty columns", () => {
    const c = (o: Partial<ColumnStats>): ColumnStats => ({ name: "c", kind: "categorical", count: 50, missing: 0, unique: 3, ...o });
    expect(targetBlock(c({ unique: 1 }))).toBe("Constant — the same value in every row");
    expect(targetBlock(c({ kind: "empty", count: 0, unique: 0 }))).toBe("Empty — no values to learn from");
  });
  it("never suggests a blocked column, and replaces a blocked server pick", () => {
    expect(suggest(t.stats)?.target).toBe("Survived");
    const bad = suggestionFor(t.stats, "PassengerId", "llm");
    expect(allowedSuggestion(t.stats, bad)?.target).toBe("Survived");
    const ok = suggestionFor(t.stats, "Pclass", "your pick");
    expect(allowedSuggestion(t.stats, ok)).toBe(ok);
  });
  it("falls back to the best allowed column when every named target is blocked", () => {
    const head =
      "id,notes,y\n" + Array.from({ length: 30 }, (_, i) => `${i},"a long unique free text note number ${i} about the row ${i * 31}",${i % 2}`).join("\n");
    expect(suggest(parseTable(head).stats)?.target).toBe("y");
  });
});

describe("setupWarnings", () => {
  it("flags tiny tables", () => {
    const t = parseTable("a,y\n" + Array.from({ length: 20 }, (_, i) => `${i},${i % 2}`).join("\n"));
    expect(setupWarnings(t.stats, "y", 20, "binary")[0]).toBe("Very small table (20 rows): scores will be noisy; try fewer experiments.");
  });
  it("flags severe imbalance, many classes and a target with missing values", () => {
    const rows = Array.from({ length: 400 }, (_, i) => `${i},${i < 8 ? "rare" : "common"}`);
    const t = parseTable("a,y\n" + rows.join("\n"));
    expect(t.stats[1].minCount).toBe(8);
    expect(setupWarnings(t.stats, "y", 400, "binary")).toEqual(["Imbalanced: the rarest class is 2.0% of rows (8); accuracy can look good while missing it."]);
    const many: ColumnStats = { name: "y", kind: "categorical", count: 850, missing: 150, unique: 60 };
    expect(setupWarnings([many], "y", 1000, "multiclass")).toEqual([
      "60 classes to tell apart: that is a lot; some will have very few examples.",
      "15% of y is empty; those rows can't be used for training.",
    ]);
  });
  it("does not warn about a healthy table", () => {
    const t = parseTable(titanicHead);
    expect(setupWarnings(t.stats, "Survived", 891, "binary")).toEqual([]);
  });
});

describe("time estimate", () => {
  it("is calibrated on real runs (sandbox start included)", () => {
    expect(estimateSeconds(891, 12, 2)).toBeGreaterThan(55);
    expect(estimateSeconds(891, 12, 2)).toBeLessThan(75); // Titanic, 2 experiments ≈ 60–70 s
    expect(estimateSeconds(891, 12, 10)).toBeGreaterThan(270);
    expect(estimateSeconds(891, 12, 10)).toBeLessThan(330); // Titanic, 10 experiments ≈ 5 min
    expect(estimateSeconds(150, 5, 5)).toBeGreaterThan(58);
    expect(estimateSeconds(150, 5, 5)).toBeLessThan(75); // iris, 5 experiments ≈ 66 s
  });
  it("reads as a range of minutes", () => {
    expect(estimateText(891, 12, 10)).toBe("≈ 3–7 min for 10 experiments");
    expect(estimateText(150, 5, 1)).toBe("≈ 1–2 min for 1 experiment");
    expect(estimateText(null, 5, 3)).toBeNull();
  });
  it("live ETA follows the pace of finished experiments", () => {
    const t0 = 1_000_000;
    // 2 of 10 done after 60 s: 30 s each, 8 left = 240 s; 10 s into the third.
    expect(liveEtaSeconds(t0, [t0 + 30_000, t0 + 60_000], 10, t0 + 70_000)).toBeCloseTo(230);
    expect(liveEtaSeconds(t0, [], 10, t0 + 5_000)).toBeNull();
    expect(liveEtaSeconds(t0, [t0 + 30_000], 1, t0 + 40_000)).toBe(0);
    expect(etaText(230)).toBe("≈ 4 min left");
    expect(etaText(30)).toBe("< 1 min left");
    expect(etaText(0)).toBeNull();
  });
});
