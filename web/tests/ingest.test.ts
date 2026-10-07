import { describe, expect, it } from "vitest";
import { parseDelimited, parseTable, profileColumn, sniffDelimiter, type ColumnKind, type ColumnStats } from "@/lib/ingest/csv";
import { buildPreview, fetchHead } from "@/lib/ingest/fetch-preview";
import { buildMessages, parseLlmSuggestion } from "@/lib/ingest/llm-suggest";
import { rewriteShareLink } from "@/lib/ingest/share-links";
import { checkUrl, isPublicIp, PreviewError, type Resolver } from "@/lib/ingest/ssrf";
import { suggest, suggestionFor } from "@/lib/ingest/suggest";
import { engineArgs } from "@/lib/runner/types";
import { _test as envTest, engineEnv, knownSecrets, PROVIDER_KEYS } from "@/lib/server-env";

// ------------------------------------------------------------------------------------------- share links

describe("rewriteShareLink", () => {
  it.each([
    ["https://github.com/o/r/blob/main/data/x.csv", "https://raw.githubusercontent.com/o/r/main/data/x.csv"],
    ["https://github.com/o/r/raw/v1.0/x.csv", "https://raw.githubusercontent.com/o/r/v1.0/x.csv"],
    ["https://drive.google.com/file/d/ABC123/view?usp=sharing", "https://drive.google.com/uc?export=download&id=ABC123"],
    ["https://drive.google.com/open?id=ABC123", "https://drive.google.com/uc?export=download&id=ABC123"],
    ["https://docs.google.com/spreadsheets/d/SHEET/edit", "https://docs.google.com/spreadsheets/d/SHEET/export?format=csv"],
    ["https://docs.google.com/spreadsheets/d/SHEET/edit#gid=42", "https://docs.google.com/spreadsheets/d/SHEET/export?format=csv&gid=42"],
    ["https://docs.google.com/spreadsheets/d/SHEET/edit?gid=7", "https://docs.google.com/spreadsheets/d/SHEET/export?format=csv&gid=7"],
    ["https://huggingface.co/datasets/o/r/blob/main/train.csv", "https://huggingface.co/datasets/o/r/resolve/main/train.csv"],
    ["https://huggingface.co/o/model/blob/main/sub/x.csv", "https://huggingface.co/o/model/resolve/main/sub/x.csv"],
    ["https://www.dropbox.com/s/abc/x.csv?dl=0", "https://www.dropbox.com/s/abc/x.csv?dl=1"],
    ["https://www.dropbox.com/scl/fi/abc/x.csv?rlkey=k", "https://www.dropbox.com/scl/fi/abc/x.csv?rlkey=k&dl=1"],
  ])("%s", (input, out) => expect(rewriteShareLink(input)).toBe(out));

  it("leaves direct and unknown links alone", () => {
    for (const u of ["https://raw.githubusercontent.com/o/r/main/x.csv", "https://example.com/data.csv", "https://github.com/o/r", "not a url"])
      expect(rewriteShareLink(u)).toBe(u);
  });
});

// -------------------------------------------------------------------------------------------------- SSRF

describe("isPublicIp", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.5",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "fe80::1", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1",
    "2001:db8::1", "2002:7f00:0001::1", "2002:0a00:0001::", "64:ff9b::7f00:1", "2001::1", "::127.0.0.1", "[::1]", "garbage",
  ])("blocks %s", (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "140.82.112.3", "185.199.108.133", "100.63.0.1", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "2002:0808:0808::1"])(
    "allows %s",
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );
});

const resolverOf =
  (map: Record<string, string[]>): Resolver =>
  async (host) => {
    if (!(host in map)) throw new Error("ENOTFOUND");
    return map[host];
  };

describe("checkUrl", () => {
  const resolve = resolverOf({ "public.example": ["93.184.216.34"], "evil.example": ["93.184.216.34", "10.0.0.5"], "v6.example": ["::1"] });
  const code = async (u: string) => {
    try {
      await checkUrl(u, resolve);
      return "ok";
    } catch (e) {
      return (e as PreviewError).code;
    }
  };
  it("accepts https to a public host", async () => expect(await code("https://public.example/x.csv")).toBe("ok"));
  it.each([
    ["http://public.example/x.csv", "not_https"],
    ["ftp://public.example/x.csv", "not_https"],
    ["file:///etc/passwd", "not_https"],
    ["https://user:pw@public.example/x.csv", "credentials"],
    ["https://evil.example/x.csv", "blocked_host"], // any private answer blocks
    ["https://v6.example/x.csv", "blocked_host"],
    ["https://127.0.0.1/x.csv", "blocked_host"],
    ["https://[::1]/x.csv", "blocked_host"],
    ["https://0x7f.1/x.csv", "blocked_host"], // WHATWG URL normalises to 127.0.0.1
    ["https://2130706433/x.csv", "blocked_host"],
    ["https://169.254.169.254/latest/meta-data", "blocked_host"],
    ["https://nowhere.example/x.csv", "dns"],
    ["not a url", "invalid_url"],
  ])("%s -> %s", async (u, c) => expect(await code(u)).toBe(c));
});

/** A fake fetch serving canned responses by URL. */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = String(input);
    const r = routes[u];
    if (!r) return new Response("missing", { status: 404 });
    return r();
  }) as typeof fetch;
}
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });
const csv = (body: string, headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers: { "content-type": "text/csv", ...headers } });

describe("fetchHead / buildPreview", () => {
  const resolver = resolverOf({ "a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"], "internal.example": ["192.168.0.10"] });

  it("follows a redirect to another public host", async () => {
    const f = fakeFetch({ "https://a.example/x.csv": redirect("https://b.example/y.csv"), "https://b.example/y.csv": csv("a,b\n1,2\n3,4\n") });
    const h = await fetchHead("https://a.example/x.csv", { fetch: f, resolver });
    expect(h.finalUrl).toBe("https://b.example/y.csv");
    expect(h.text).toBe("a,b\n1,2\n3,4\n");
  });
  it("blocks a redirect to a private host", async () => {
    const f = fakeFetch({ "https://a.example/x.csv": redirect("https://internal.example/secret.csv") });
    await expect(fetchHead("https://a.example/x.csv", { fetch: f, resolver })).rejects.toMatchObject({ code: "blocked_host" });
  });
  it("blocks a redirect to a private IP literal and to plain http", async () => {
    let f = fakeFetch({ "https://a.example/x.csv": redirect("https://169.254.169.254/") });
    await expect(fetchHead("https://a.example/x.csv", { fetch: f, resolver })).rejects.toMatchObject({ code: "blocked_host" });
    f = fakeFetch({ "https://a.example/x.csv": redirect("http://b.example/x.csv", 301) });
    await expect(fetchHead("https://a.example/x.csv", { fetch: f, resolver })).rejects.toMatchObject({ code: "not_https" });
  });
  it("gives up after 3 redirects", async () => {
    const f = fakeFetch({
      "https://a.example/1": redirect("/2"),
      "https://a.example/2": redirect("/3"),
      "https://a.example/3": redirect("/4"),
      "https://a.example/4": redirect("/5"),
    });
    await expect(fetchHead("https://a.example/1", { fetch: f, resolver })).rejects.toMatchObject({ code: "too_many_redirects" });
  });
  it("maps 404 and 403", async () => {
    await expect(fetchHead("https://a.example/nope.csv", { fetch: fakeFetch({}), resolver })).rejects.toMatchObject({ code: "not_found" });
    const f = fakeFetch({ "https://a.example/x.csv": () => new Response("no", { status: 403 }) });
    await expect(fetchHead("https://a.example/x.csv", { fetch: f, resolver })).rejects.toMatchObject({ code: "http_error" });
  });
  it("refuses a declared size over the engine limit", async () => {
    const f = fakeFetch({ "https://a.example/x.csv": csv("a,b\n", { "content-length": String(80 * 1024 * 1024) }) });
    await expect(fetchHead("https://a.example/x.csv", { fetch: f, resolver })).rejects.toMatchObject({ code: "too_big" });
  });
  it("reads only the first maxBytes and estimates rows from content-length", async () => {
    const body = "x,y\n" + Array.from({ length: 1000 }, (_, i) => `${i},${i % 2}`).join("\n") + "\n";
    const f = fakeFetch({ "https://a.example/x.csv": csv(body, { "content-length": String(body.length) }) });
    const p = await buildPreview("https://a.example/x.csv", { fetch: f, resolver, maxBytes: 2000 });
    expect(p.rowsExact).toBe(false);
    expect(p.rows).toBeGreaterThan(800);
    expect(p.rows).toBeLessThan(1200);
    expect(p.columns).toEqual(["x", "y"]);
  });
  it("times out", async () => {
    const slow = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    await expect(fetchHead("https://a.example/x.csv", { fetch: slow, resolver, timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
  });
  it("rejects web pages, parquet and zip with a clear message", async () => {
    const html = fakeFetch({ "https://a.example/x.csv": () => new Response("<!DOCTYPE html><html><body>Google Drive can't scan this file</body></html>", { headers: { "content-type": "text/html" } }) });
    await expect(buildPreview("https://a.example/x.csv", { fetch: html, resolver })).rejects.toMatchObject({ code: "html" });
    const pq = fakeFetch({ "https://a.example/x.csv": () => new Response("PAR1\u0000\u0001") });
    await expect(buildPreview("https://a.example/x.csv", { fetch: pq, resolver })).rejects.toMatchObject({ code: "not_csv" });
    const zip = fakeFetch({ "https://a.example/x.csv": () => new Response("PK\u0003\u0004xx") });
    await expect(buildPreview("https://a.example/x.csv", { fetch: zip, resolver })).rejects.toMatchObject({ code: "not_csv" });
  });
  it("rewrites a share link before fetching", async () => {
    const f = fakeFetch({ "https://raw.githubusercontent.com/o/r/main/x.csv": csv("a,b\n1,2\n") });
    const p = await buildPreview("https://github.com/o/r/blob/main/x.csv", {
      fetch: f,
      resolver: resolverOf({ "raw.githubusercontent.com": ["185.199.108.133"] }),
    });
    expect(p.rewritten).toBe(true);
    expect(p.resolvedUrl).toBe("https://raw.githubusercontent.com/o/r/main/x.csv");
    expect(p.rows).toBe(1);
    expect(p.rowsExact).toBe(true);
  });
});

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

// ----------------------------------------------------------------------------------------- LLM (no network)

describe("LLM suggestion helpers", () => {
  const stats = [col("age", "integer", 50, 100), col("churn", "categorical", 2, 100)];
  const sample = [["31", "yes"], ["45", "no"]];
  it("never puts data rows in the Gemini prompt", () => {
    const gemini = JSON.stringify(buildMessages({ stats, sample, goal: "who leaves", heuristic: null }, false));
    expect(gemini).not.toContain("First rows");
    expect(gemini).not.toContain('"31"');
    const groq = JSON.stringify(buildMessages({ stats, sample, goal: "who leaves", heuristic: null }, true));
    expect(groq).toContain("First rows");
  });
  it("validates the model's JSON against the columns and the metric against the type", () => {
    expect(parseLlmSuggestion('{"target":"nope"}', stats)).toBeNull();
    expect(parseLlmSuggestion("not json", stats)).toBeNull();
    expect(parseLlmSuggestion('```json\n{"target":"churn","problem_type":"binary","metric":"rmse","goal_plain":"Predict churn"}\n```', stats)).toEqual({
      target: "churn",
      source: "llm",
      problemType: "binary",
      goalPlain: "Predict churn",
    });
  });
});

// ----------------------------------------------------------------------------------------- engine command

describe("engineArgs (agentic path)", () => {
  it("builds `autotinker run` with the link, target, metric, goal and budget", () => {
    expect(engineArgs({ source: "https://x.example/d.csv", target: "y", metric: "roc_auc", goal: "predict y", maxExperiments: 10, outDir: "/tmp/o" })).toEqual([
      "-m", "autotinker", "run", "https://x.example/d.csv", "--target", "y", "--metric", "roc_auc", "--goal", "predict y", "--max-experiments", "10", "--out", "/tmp/o", "--events-stdout",
    ]);
  });
  it("omits metric/goal when absent and never passes legacy flags", () => {
    const a = engineArgs({ source: "/data/in.csv", target: "y", maxExperiments: 3, outDir: "/o" });
    expect(a).not.toContain("--metric");
    expect(a).not.toContain("--goal");
    for (const legacy of ["--llm", "--max-cost", "--description", "evolve"]) expect(a).not.toContain(legacy);
  });
});

describe("server-env .env parsing", () => {
  it("parses quotes, export and comments", () => {
    expect(envTest.parseDotenv('# c\nexport A="x y"\nB=\'z\'\nC=plain # note\n\nbad line\n')).toEqual({ A: "x y", B: "z", C: "plain" });
  });
});

describe("engine environment", () => {
  it("passes provider keys and engine settings, never database URLs or other credentials", () => {
    const env = engineEnv();
    for (const k of Object.keys(env)) {
      expect(k).not.toMatch(/DATABASE|POSTGRES|TOKEN|SECRET|PASSWORD/);
      expect((PROVIDER_KEYS as readonly string[]).includes(k) || /^AUTOTINKER_/.test(k)).toBe(true);
    }
    expect(knownSecrets().length).toBe(PROVIDER_KEYS.filter((k) => env[k]).length);
  });
});
