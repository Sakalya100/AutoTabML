import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, previewCsv, redact, splitCsvLine, validateRunRequest, type RunRequestInput } from "@/lib/upload";

const iris = readFileSync(path.join(__dirname, "../../examples/data/iris_classification.csv"), "utf8");
const base = (over: Partial<RunRequestInput> = {}): RunRequestInput => ({
  fileName: "iris.csv", fileBytes: iris.length, head: iris, complete: true, target: "variety",
  description: "", maxExperiments: "8", llm: "heuristic", apiKey: null, ...over,
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
    expect(r.ok && r.value).toMatchObject({ target: "variety", maxExperiments: 8, llm: "heuristic" });
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
    [{ maxExperiments: "31" }, "maxExperiments"],
    [{ maxExperiments: "0" }, "maxExperiments"],
    [{ maxExperiments: "2.5" }, "maxExperiments"],
    [{ description: "x".repeat(2001) }, "description"],
    [{ llm: "gpt" }, "llm"],
    [{ apiKey: "sk-ant-xyz" }, "apiKey"], // key with heuristic
    [{ llm: "anthropic", apiKey: "has space" }, "apiKey"],
  ] as [Partial<RunRequestInput>, string][])("rejects %o on field %s", (over, field) => {
    const r = validateRunRequest(base(over));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe(field);
  });
  it("does not enforce the row minimum on a prefix", () => {
    expect(validateRunRequest(base({ head: "a,b\n1,2\n", complete: false, target: "b" })).ok).toBe(true);
  });
});

describe("redact", () => {
  it("removes explicit secrets and anything shaped like an Anthropic key", () => {
    expect(redact("key=supersecretvalue!", ["supersecretvalue"])).toBe("key=[redacted]!");
    expect(redact("auth sk-ant-api03-AbC_dEf-123456 failed")).toBe("auth [redacted] failed");
  });
});
