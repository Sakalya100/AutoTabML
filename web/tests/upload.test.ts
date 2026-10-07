import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, previewCsv, redact, splitCsvLine, validateRunRequest, validateUrlRunRequest, type RunRequestInput } from "@/lib/upload";

const iris = readFileSync(path.join(__dirname, "../../examples/data/iris_classification.csv"), "utf8");
const base = (over: Partial<RunRequestInput> = {}): RunRequestInput => ({
  fileName: "iris.csv", fileBytes: iris.length, head: iris, complete: true, target: "variety",
  goal: "", metric: null, maxExperiments: "8", ...over,
});

describe("CSV header parsing", () => {
  it("handles quoted names, escaped quotes, BOM and CRLF", () => {
    expect(splitCsvLine('"a,b",c,"d ""x"""')).toEqual(["a,b", "c", 'd "x"']);
    const p = previewCsv('﻿"sepal.length","variety"\r\n5.1,"Setosa"\r\n', 5);
    expect(p.columns).toEqual(["sepal.length", "variety"]);
    expect(p.rows).toEqual([["5.1", "Setosa"]]);
    expect(p.rowCount).toBe(1);
  });
  it("reads the iris example header", () => {
    expect(previewCsv(iris).columns).toEqual(["sepal.length", "sepal.width", "petal.length", "petal.width", "variety"]);
  });
});

describe("validateRunRequest", () => {
  it("accepts the iris example", () => {
    const r = validateRunRequest(base());
    expect(r.ok && r.value).toMatchObject({ target: "variety", maxExperiments: 8, metric: null, goal: "" });
  });
  it.each([
    [{ fileName: "iris.xlsx" }, "file"],
    [{ fileBytes: MAX_UPLOAD_BYTES + 1 }, "file"],
    [{ fileBytes: 0 }, "file"],
    [{ head: "a\u0000b,c\n" }, "file"],
    [{ head: "onlyone\n1\n" }, "file"],
    [{ head: "a,a\n1,2\n" }, "file"],
    [{ head: "a,b\n1,2\n" }, "file"], // too few rows
    [{ target: "species" }, "target"],
    [{ target: "" }, "target"],
    [{ maxExperiments: "11" }, "maxExperiments"],
    [{ maxExperiments: "0" }, "maxExperiments"],
    [{ maxExperiments: "2.5" }, "maxExperiments"],
    [{ goal: "x".repeat(2001) }, "goal"],
    [{ metric: "auc" }, "metric"],
  ] as [Partial<RunRequestInput>, string][])("rejects %o on field %s", (over, field) => {
    const r = validateRunRequest(base(over));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe(field);
  });
  it("does not enforce the row minimum on a prefix", () => {
    expect(validateRunRequest(base({ head: "a,b\n1,2\n", complete: false, target: "b" })).ok).toBe(true);
  });
});

describe("validateUrlRunRequest", () => {
  const ok = { url: "https://raw.githubusercontent.com/o/r/main/x.csv", target: "y", maxExperiments: 10 };
  it("accepts a link with defaults and an optional metric/goal", () => {
    const r = validateUrlRunRequest({ ...ok, metric: "roc_auc", goal: "predict y" });
    expect(r.ok && r.value).toMatchObject({ url: ok.url, target: "y", metric: "roc_auc", goal: "predict y", maxExperiments: 10 });
  });
  it.each([
    [{ url: "" }, "url"],
    [{ url: "not a link" }, "url"],
    [{ url: "http://example.com/x.csv" }, "url"],
    [{ url: "ftp://example.com/x.csv" }, "url"],
    [{ url: "https://user:pw@example.com/x.csv" }, "url"],
    [{ url: "https://example.com/" + "a".repeat(2100) }, "url"],
    [{ target: "" }, "target"],
    [{ target: "a\nb" }, "target"],
    [{ maxExperiments: 0 }, "maxExperiments"],
    [{ maxExperiments: 11 }, "maxExperiments"],
    [{ metric: "accuracy; rm -rf /" }, "metric"],
  ] as [Record<string, unknown>, string][])("rejects %o on field %s", (over, field) => {
    const r = validateUrlRunRequest({ ...ok, ...over } as Parameters<typeof validateUrlRunRequest>[0]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe(field);
  });
});

describe("redact", () => {
  it("removes explicit secrets and anything shaped like an Anthropic key", () => {
    expect(redact("key=supersecretvalue!", ["supersecretvalue"])).toBe("key=[redacted]!");
    expect(redact("auth sk-ant-api03-AbC_dEf-123456 failed")).toBe("auth [redacted] failed");
  });
  it("removes Groq, Google, Cerebras and Neon key shapes", () => {
    const fake = ["gsk_" + "A1b2C3d4E5f6G7h8", "AQ." + "Ab12_cd34-ef56gh", "csk-" + "abcd1234efgh5678", "npg_" + "AbCdEf123456"];
    for (const k of fake) expect(redact(`x ${k} y`)).toBe("x [redacted] y");
  });
});
