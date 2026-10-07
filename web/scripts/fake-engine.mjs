// Stand-in for the Python engine, for UI/pipeline development without Python:
//   AUTOTINKER_PYTHON_CMD="node scripts/fake-engine.mjs" npm run dev
// Accepts (and ignores) the real CLI arguments, streams the bundled iris fixture's events to stdout with a
// delay, and writes its run.json to --out. It is NOT the engine: the numbers are the fixture's, whatever CSV you upload.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const delay = Number(process.env.FAKE_ENGINE_DELAY_MS ?? 200);
const dir = resolve(here, "fixtures/iris-heuristic");
const runId = `r-fake-${Date.now()}`;
const lines = readFileSync(resolve(dir, "events.jsonl"), "utf8").trim().split("\n");

process.stderr.write(`fake-engine: streaming ${lines.length} fixture events (args: ${args.join(" ")})\n`);
for (const line of lines) {
  const ev = { ...JSON.parse(line), run_id: runId, ts: new Date().toISOString() };
  process.stdout.write(JSON.stringify(ev) + "\n");
  await new Promise((r) => setTimeout(r, delay));
}
if (out && out !== "--out") {
  mkdirSync(out, { recursive: true });
  const rec = JSON.parse(readFileSync(resolve(dir, "run.json"), "utf8"));
  writeFileSync(resolve(out, "run.json"), JSON.stringify({ ...rec, run_id: runId }));
}
