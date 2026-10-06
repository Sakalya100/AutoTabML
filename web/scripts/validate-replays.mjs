// Validate every bundled replay (public/replays/<name>/{run.json,events.jsonl}) against ../schema/*.schema.json,
// plus the cross-file invariants the UI relies on (one run_id, strictly increasing seq, run.json agrees with events).
// Usage: node scripts/validate-replays.mjs   (exit 1 on any failure)
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(here, "../../schema");
const replayDir = resolve(here, "../public/replays");

// strict:false — Pydantic emits a root `discriminator` keyword and `title`s; the tag (`type`) has a default and
// is not in `required`, so Ajv's discriminator mode would reject the schema. The per-branch `const` on `type`
// still makes `oneOf` resolve to exactly one branch.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateEvent = ajv.compile(JSON.parse(readFileSync(resolve(schemaDir, "events.schema.json"), "utf8")));
const validateRecord = ajv.compile(JSON.parse(readFileSync(resolve(schemaDir, "run_record.schema.json"), "utf8")));

const fmt = (errs) => ajv.errorsText(errs, { separator: "\n    " });
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`  ✗ ${msg}`);
};

// Self-check: a wrong event must be rejected, or the validator proves nothing.
if (validateEvent({ run_id: "x", type: "decision", exp_id: "e0" })) {
  console.error("validator self-check failed: an incomplete decision event was accepted");
  process.exit(1);
}
if (validateEvent({ run_id: "x", type: "not_a_type", summary: "s", reason: "ceiling", report: {} })) {
  console.error("validator self-check failed: an unknown event type was accepted");
  process.exit(1);
}

const index = JSON.parse(readFileSync(resolve(replayDir, "index.json"), "utf8"));
for (const { name } of index.replays) {
  console.log(`replay ${name}`);
  const dir = resolve(replayDir, name);
  for (const f of ["run.json", "events.jsonl"]) if (!existsSync(resolve(dir, f))) fail(`missing ${f}`);
  if (failures) continue;

  const record = JSON.parse(readFileSync(resolve(dir, "run.json"), "utf8"));
  if (!validateRecord(record)) fail(`run.json: ${fmt(validateRecord.errors)}`);

  const lines = readFileSync(resolve(dir, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim());
  let lastSeq = -1;
  const types = [];
  lines.forEach((line, i) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return fail(`events.jsonl:${i + 1}: not JSON`);
    }
    if (!validateEvent(ev)) fail(`events.jsonl:${i + 1} (${ev.type}): ${fmt(validateEvent.errors)}`);
    if (ev.run_id !== record.run_id) fail(`events.jsonl:${i + 1}: run_id ${ev.run_id} != ${record.run_id}`);
    if (!(ev.seq > lastSeq)) fail(`events.jsonl:${i + 1}: seq ${ev.seq} not > ${lastSeq}`);
    lastSeq = ev.seq;
    types.push(ev.type);
  });
  if (types[0] !== "run_started") fail("first event is not run_started");
  const started = lines.map((l) => JSON.parse(l)).filter((e) => e.type === "experiment_started");
  if (started.length !== record.experiments.length)
    fail(`events have ${started.length} experiments, run.json has ${record.experiments.length}`);
  const fin = lines.map((l) => JSON.parse(l)).find((e) => e.type === "run_finished");
  if (record.final && fin && Math.abs(fin.test_score - record.final.test_score) > 1e-9)
    fail("run_finished.test_score disagrees with run.json final.test_score");
  if (!failures) console.log(`  ✓ run.json + ${lines.length} events valid`);
}
if (failures) {
  console.error(`${failures} problem(s)`);
  process.exit(1);
}
console.log("all replays valid");
