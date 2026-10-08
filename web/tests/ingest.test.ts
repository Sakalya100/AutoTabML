import { describe, expect, it } from "vitest";
import { parseDelimited, parseTable, profileColumn, sniffDelimiter, type ColumnKind, type ColumnStats } from "@/lib/ingest/csv";
import { suggest, suggestionFor } from "@/lib/ingest/suggest";

// The link preview itself (SSRF guard, share links, guarded fetch, LLM refinement) is the backend's now:
// backend/tests/test_preview.py. These are the browser-side parsers and heuristics it mirrors.

// -------------------------------------------------------------------------------------------------- CSV

describe("CSV sniff and parse", () => {
  it("detects , ; tab and | delimiters", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(sniffDelimiter("a;b;c\n1,5;2,5;3\n")).toBe(";"); // European decimals
    expect(sniffDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(sniffDelimiter("a|b\n1|2\n")).toBe("|");
    expect(sniffDelimiter('"x, y";b\n"1, 2";3\n')).toBe(";"); // commas inside quotes don't count
  });
  it("handles BOM, CRLF, quotes, escaped quotes and newlines inside quotes", () => {
    const rows = parseDelimited('﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nAnn,ok\r\n', ",");
    expect(rows).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["Ann", "ok"],
    ]);
  });
  it("drops a cut-off last record when the text is a prefix", () => {
    expect(parseDelimited("a,b\n1,2\n3,4", ",", { partial: true })).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseDelimited("a,b\n1,2\n3,4", ",")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });
  it("pads short rows and names blank headers", () => {
    const t = parseTable("a,,c\n1,2\n");
    expect(t.columns).toEqual(["a", "column_2", "c"]);
    expect(t.sample[0]).toEqual(["1", "2", ""]);
  });
  it("infers column kinds", () => {
    const kind = (name: string, vals: string[]) => profileColumn(name, vals).kind;
    expect(kind("age", ["22", "38", "", "NA", "35"])).toBe("integer");
    expect(kind("fare", ["7.25", "71.2833", "8.05"])).toBe("numeric");
    expect(kind("Survived", ["0", "1", "1", "0"])).toBe("boolean");
    expect(kind("smoker", ["yes", "no", "no"])).toBe("boolean");
    expect(kind("Sex", ["male", "female", "male", "female"])).toBe("categorical");
    expect(kind("date", ["2024-01-02", "2024-02-03", "2024-03-04"])).toBe("datetime");
    expect(kind("PassengerId", Array.from({ length: 30 }, (_, i) => String(i + 1)))).toBe("id");
    expect(kind("empty", ["", "NA", "?"])).toBe("empty");
  });
});

// -------------------------------------------------------------------------------------------- heuristics

/** Synthetic stats in the shape the preview produces. */
const col = (name: string, kind: ColumnKind, unique: number, n = 500, missing = 0): ColumnStats => ({ name, kind, unique, count: n - missing, missing });

describe("heuristic suggestions on real-world headers", () => {
  it("Titanic -> Survived, binary, ROC-AUC", () => {
    const s = suggest([
      col("PassengerId", "id", 891, 891), col("Survived", "boolean", 2, 891), col("Pclass", "integer", 3, 891), col("Name", "text", 891, 891),
      col("Sex", "categorical", 2, 891), col("Age", "numeric", 88, 891, 177), col("SibSp", "integer", 7, 891), col("Parch", "integer", 7, 891),
      col("Ticket", "text", 681, 891), col("Fare", "numeric", 248, 891), col("Cabin", "categorical", 147, 891, 687), col("Embarked", "categorical", 3, 891, 2),
    ]);
    expect(s).toMatchObject({ target: "Survived", problemType: "binary", metric: "roc_auc", ambiguous: false });
  });
  it("selva86 BreastCancer -> Class, binary", () => {
    const s = suggest([
      col("Id", "integer", 645, 699), col("Cl.thickness", "integer", 10, 699), col("Cell.size", "integer", 10, 699), col("Cell.shape", "integer", 10, 699),
      col("Marg.adhesion", "integer", 10, 699), col("Epith.c.size", "integer", 10, 699), col("Bare.nuclei", "integer", 10, 699, 16),
      col("Bl.cromatin", "integer", 10, 699), col("Normal.nucleoli", "integer", 10, 699), col("Mitoses", "integer", 9, 699), col("Class", "boolean", 2, 699),
    ]);
    expect(s).toMatchObject({ target: "Class", problemType: "binary", metric: "roc_auc" });
  });
  it("Telco churn -> Churn (not customerID)", () => {
    const s = suggest([
      col("customerID", "id", 7043, 7043), col("gender", "categorical", 2, 7043), col("SeniorCitizen", "boolean", 2, 7043), col("tenure", "integer", 73, 7043),
      col("Contract", "categorical", 3, 7043), col("MonthlyCharges", "numeric", 1585, 7043), col("TotalCharges", "numeric", 6530, 7043, 11),
      col("Churn", "boolean", 2, 7043),
    ]);
    expect(s).toMatchObject({ target: "Churn", problemType: "binary" });
  });
  it("Boston housing -> medv, regression, RMSE", () => {
    const names = ["crim", "zn", "indus", "chas", "nox", "rm", "age", "dis", "rad", "tax", "ptratio", "b", "lstat"];
    const s = suggest([...names.map((n) => col(n, n === "chas" ? "boolean" : "numeric", 400, 506)), col("medv", "numeric", 229, 506)]);
    expect(s).toMatchObject({ target: "medv", problemType: "regression", metric: "rmse" });
  });
  it("Kaggle house prices -> SalePrice even when not last-but-one", () => {
    const s = suggest([col("Id", "id", 1460, 1460), col("MSSubClass", "integer", 15, 1460), col("LotArea", "integer", 1073, 1460), col("SalePrice", "integer", 663, 1460), col("YrSold", "integer", 5, 1460)]);
    expect(s).toMatchObject({ target: "SalePrice", problemType: "regression" });
  });
  it("Iris (HF) -> Species, multiclass, log-loss", () => {
    const s = suggest([col("Id", "id", 150, 150), col("SepalLengthCm", "numeric", 35, 150), col("SepalWidthCm", "numeric", 23, 150), col("PetalLengthCm", "numeric", 43, 150), col("PetalWidthCm", "numeric", 22, 150), col("Species", "categorical", 3, 150)]);
    expect(s).toMatchObject({ target: "Species", problemType: "multiclass", metric: "log_loss" });
  });
  it("wine quality (integer 3..8) -> quality, multiclass like the engine", () => {
    const s = suggest([col("fixed acidity", "numeric", 96, 1599), col("alcohol", "numeric", 65, 1599), col("quality", "integer", 6, 1599)]);
    expect(s).toMatchObject({ target: "quality", problemType: "multiclass" });
  });
  it("adult income -> income; the goal sentence can override", () => {
    const stats = [col("age", "integer", 73, 32561), col("workclass", "categorical", 9, 32561), col("education", "categorical", 16, 32561), col("sex", "categorical", 2, 32561), col("hours.per.week", "integer", 94, 32561), col("income", "categorical", 2, 32561)];
    expect(suggest(stats)).toMatchObject({ target: "income", problemType: "binary" });
    expect(suggest(stats, "predict how many hours per week people work")).toMatchObject({ target: "hours.per.week", problemType: "regression" });
  });
  it("flags ambiguity when nothing looks like a target", () => {
    const s = suggest([col("a", "numeric", 100), col("b", "numeric", 100), col("c", "numeric", 100)]);
    expect(s?.ambiguous).toBe(true);
    expect(s?.target).toBe("c"); // falls back to the last column
  });
  it("suggestionFor mirrors the engine's problem-type rule", () => {
    const stats = [col("x", "numeric", 100, 1000), col("y", "integer", 30, 1000), col("z", "integer", 15, 1000)];
    expect(suggestionFor(stats, "y", "").problemType).toBe("regression"); // > 20 distinct
    expect(suggestionFor(stats, "z", "").problemType).toBe("multiclass"); // 15 distinct, ratio 1.5%
  });
});
