import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlEventDecoder, coerceEvent, parseEventLine, parseEventsJsonl } from "@/lib/events";

const fixture = readFileSync(path.join(__dirname, "../scripts/fixtures/iris-heuristic/events.jsonl"), "utf8");
const decision = { run_id: "r-x", seq: 3, ts: "2026-01-01T00:00:00Z", type: "decision", exp_id: "e001", decision: "keep", reason: "", best_exp_id: "e001", best_cv_mean: 0.9 };

describe("parseEventLine", () => {
  it("parses a valid event", () => {
    const e = parseEventLine(JSON.stringify(decision));
    expect(e?.type).toBe("decision");
    expect(e?.seq).toBe(3);
  });
  it("rejects blank, non-JSON, unknown types and incomplete events", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("Traceback (most recent call last):")).toBeNull();
    expect(parseEventLine("{not json")).toBeNull();
    expect(parseEventLine(JSON.stringify({ ...decision, type: "mystery" }))).toBeNull();
    const { best_exp_id: _drop, ...partial } = decision;
    void _drop;
    expect(parseEventLine(JSON.stringify(partial))).toBeNull();
    expect(coerceEvent({ ...decision, seq: -1 })).toBeNull();
    expect(coerceEvent([1, 2])).toBeNull();
  });
  it("fills a missing ts", () => {
    const { ts: _ts, ...noTs } = decision;
    void _ts;
    expect(typeof coerceEvent(noTs)?.ts).toBe("string");
  });
});

describe("parseEventsJsonl", () => {
  it("parses the bundled fixture end to end", () => {
    const events = parseEventsJsonl(fixture);
    expect(events.length).toBe(fixture.trim().split("\n").length);
    expect(events[0].type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_finished");
    expect(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq)).toBe(true);
  });
});

describe("JsonlEventDecoder", () => {
  it("reassembles lines split across arbitrary chunk boundaries", () => {
    const text = fixture;
    const dec = new JsonlEventDecoder();
    const out = [];
    for (let i = 0; i < text.length; i += 37) out.push(...dec.push(text.slice(i, i + 37)));
    out.push(...dec.end());
    expect(out.length).toBe(parseEventsJsonl(fixture).length);
  });
  it("reports non-event lines and drops duplicate/out-of-order seq", () => {
    const other: string[] = [];
    const dec = new JsonlEventDecoder((l) => other.push(l));
    const line = (seq: number) => JSON.stringify({ ...decision, seq });
    const got = dec.push(`progress: 10%\n${line(1)}\r\n${line(1)}\n${line(0)}\n${line(2)}`);
    expect(got.map((e) => e.seq)).toEqual([1]);
    expect(dec.end().map((e) => e.seq)).toEqual([2]);
    expect(other).toEqual(["progress: 10%"]);
  });
});
