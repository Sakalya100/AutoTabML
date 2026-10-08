/**
 * Local runner (default in dev): spawns the Python engine as a child process on this machine and turns its
 * stdout JSONL into stored events.
 *
 *   <AUTOTINKER_PYTHON_CMD> -m autotinker run <url|csv> --target <t> [--metric m] [--goal g] --max-experiments N --out <dir> --events-stdout
 *
 * Environment: a small allow-list of system variables, plus the LLM provider keys and AUTOTINKER_* engine settings
 * (from process.env or the repo-root .env, see lib/server-env.ts). DATABASE_URL and other credentials never reach the
 * engine; they are set to "" so the engine's own .env loader (python-dotenv, override=False) can't pick them up.
 *
 * AUTOTINKER_PYTHON_CMD defaults to `uv run --project <repo root> python` (repo root = parent of web/). It is split
 * on whitespace, so paths in it must not contain spaces. Generated pipelines are sandboxed by the engine's own
 * harness, not by this process — only run this runner on a machine you trust with the uploaded data.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { JsonlEventDecoder } from "../events";
import type { RunRecord } from "../schema";
import { getStore } from "../store";
import type { RunMeta } from "../store/types";
import { engineEnv, knownSecrets } from "../server-env";
import { redact } from "../upload";
import { engineArgs, type ControlCommand, type Runner, type StartOptions } from "./types";

interface Live {
  child: ChildProcess;
  cancelled: boolean;
}
// On globalThis so `next dev` hot reloads don't lose track of running children (cancel would break).
const g = globalThis as unknown as { __autotinkerLocalRuns?: Map<string, Live> };
const live = (g.__autotinkerLocalRuns ??= new Map());

const ENV_ALLOW = /^(PATH|HOME|USER|LANG|LC_[A-Z]+|TMPDIR|TEMP|TMP|SHELL|UV_[A-Z_]+|PYTHON[A-Z_]*|VIRTUAL_ENV|CONDA_[A-Z_]+|SYSTEMROOT|OMP_NUM_THREADS)$/;
/** Set to "" in the engine env so python-dotenv won't load them from the repo-root .env. */
const BLOCKED_FROM_DOTENV = ["DATABASE_URL", "DATABASE_URL_POOLED", "DATABASE_URL_UNPOOLED", "POSTGRES_URL", "ANTHROPIC_API_KEY"];

export function activeLocalRuns(): number {
  return live.size;
}

export function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

export function pythonCommand(): string[] {
  const raw = process.env.AUTOTINKER_PYTHON_CMD?.trim() || `uv run --project ${repoRoot()} python`;
  return raw.split(/\s+/);
}

function dataRoot(): string {
  return process.env.AUTOTINKER_DATA_DIR ?? path.join(process.cwd(), ".data");
}

async function findRunJson(outDir: string): Promise<string | null> {
  const direct = path.join(outDir, "run.json");
  try {
    await fs.access(direct);
    return direct;
  } catch {}
  try {
    for (const d of await fs.readdir(outDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(outDir, d.name, "run.json");
      try {
        await fs.access(p);
        return p;
      } catch {}
    }
  } catch {}
  return null;
}

export class LocalRunner implements Runner {
  readonly kind = "local" as const;

  async start({ meta, csv }: StartOptions): Promise<void> {
    const store = getStore();
    const dir = path.join(dataRoot(), "runs", meta.id);
    const outDir = path.join(dir, "out");
    const csvPath = path.join(dir, "input.csv");
    await fs.mkdir(outDir, { recursive: true });
    let source: string;
    if (meta.source === "url" && meta.sourceUrl) source = meta.sourceUrl;
    else if (csv) {
      await fs.writeFile(csvPath, csv);
      source = csvPath;
    } else throw new Error("nothing to run: no link and no uploaded file");

    const [cmd, ...pre] = pythonCommand();
    const args = [
      ...pre,
      ...engineArgs({ source, target: meta.target, metric: meta.metric, goal: meta.description, maxExperiments: meta.maxExperiments, outDir, controlStdin: true }),
    ];

    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) if (ENV_ALLOW.test(k)) env[k] = v;
    Object.assign(env, engineEnv());
    for (const k of BLOCKED_FROM_DOTENV) env[k] = "";
    env.PYTHONUNBUFFERED = "1";
    const secrets = knownSecrets();

    // argv only — never the env, which may hold the key.
    console.info(`[run ${meta.id}] spawn: ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { cwd: repoRoot(), env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    const entry: Live = { child, cancelled: false };
    // The control channel: a closed pipe (engine exited) must not crash the server.
    child.stdin?.on("error", (err) => console.warn(`[run ${meta.id}] control channel closed (${(err as NodeJS.ErrnoException).code ?? err.message})`));
    live.set(meta.id, entry);
    await store.updateMeta(meta.id, { status: "starting" });

    let chain: Promise<unknown> = Promise.resolve();
    let sawEvent = false;
    const save = (evs: ReturnType<JsonlEventDecoder["push"]>) => {
      if (!evs.length) return;
      chain = chain.then(async () => {
        if (!sawEvent) {
          sawEvent = true;
          await store.updateMeta(meta.id, { status: "running" });
        }
        await store.appendEvents(meta.id, evs);
      }).catch((err) => console.error(`[run ${meta.id}] store error`, err));
    };
    const decoder = new JsonlEventDecoder((line) => console.info(`[run ${meta.id}] stdout: ${redact(line, secrets).slice(0, 500)}`));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => save(decoder.push(chunk)));

    const tail: string[] = [];
    let partial = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) {
        const safe = redact(l, secrets);
        console.warn(`[run ${meta.id}] stderr: ${safe}`);
        tail.push(safe);
        if (tail.length > 60) tail.shift();
      }
    });

    const maxS = Number(process.env.AUTOTINKER_RUN_TIMEOUT_S ?? 3600);
    const timer = setTimeout(() => {
      console.warn(`[run ${meta.id}] exceeded ${maxS}s, killing`);
      killTree(child, "SIGTERM");
    }, maxS * 1000);

    const finish = async (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      clearTimeout(timer);
      live.delete(meta.id);
      save(decoder.end());
      if (partial) tail.push(redact(partial, secrets));
      await chain;
      const runJson = await findRunJson(outDir);
      if (runJson) {
        try {
          await store.putRecord(meta.id, JSON.parse(await fs.readFile(runJson, "utf8")) as RunRecord);
        } catch (err) {
          console.error(`[run ${meta.id}] could not read run.json`, err);
        }
      }
      await fs.rm(csvPath, { force: true }); // uploads are not kept after the run
      // Local paths (run directory, tracebacks) stay in the server log, not in what the browser sees.
      const errorTail = tail
        .slice(-40)
        .filter((l) => !/^run directory:/.test(l))
        .map((l) => l.split(repoRoot()).join("…"))
        .join("\n");
      const patch = exitPatch({ code, signal, cancelled: entry.cancelled, hasRunJson: !!runJson, spawnError, errorTail });
      await store.updateMeta(meta.id, { ...patch, finishedAt: new Date().toISOString() });
      console.info(`[run ${meta.id}] ${patch.status}`);
    };
    let done = false;
    child.on("error", (err) => {
      if (!done) {
        done = true;
        void finish(null, null, err);
      }
    });
    child.on("close", (code, signal) => {
      if (!done) {
        done = true;
        void finish(code, signal);
      }
    });
  }

  async control(meta: RunMeta, cmd: ControlCommand): Promise<boolean> {
    const entry = live.get(meta.id);
    const stdin = entry?.child.stdin;
    if (!entry || entry.cancelled || !stdin || stdin.destroyed || !stdin.writable) return false;
    return new Promise((resolve) => {
      stdin.write(JSON.stringify(cmd) + "\n", (err?: Error | null) => resolve(!err));
    });
  }

  async cancel(meta: RunMeta): Promise<boolean> {
    const entry = live.get(meta.id);
    if (!entry) return false;
    entry.cancelled = true;
    killTree(entry.child, "SIGTERM");
    setTimeout(() => {
      if (entry.child.exitCode === null && entry.child.signalCode === null) killTree(entry.child, "SIGKILL");
    }, 5000).unref();
    return true;
  }
}

/** The run's final status from how the engine process ended. Pure, so the races below are unit-tested. */
export function exitPatch(x: {
  code: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  hasRunJson: boolean;
  spawnError?: Error | null;
  errorTail?: string;
}): Partial<RunMeta> {
  // A cancel that raced the engine's own clean exit (locked test + report already written) doesn't undo the run.
  if (x.cancelled && !(x.code === 0 && x.hasRunJson)) return { status: "cancelled", error: "Cancelled by user." };
  if (x.spawnError)
    return { status: "failed", error: `Could not start the engine (${x.spawnError.message}). Is uv installed and AUTOTINKER_PYTHON_CMD correct?` };
  if (x.code === 0) return { status: "finished" };
  // Exit 3 = the agents gave up early (proposer_failure). The engine still scored the locked test and reported.
  if (x.code === 3 && x.hasRunJson)
    return { status: "finished", error: "The agents stopped early after repeated failures; the best model so far was scored on the locked test." };
  return { status: "failed", error: `The engine exited with ${x.code !== null ? `code ${x.code}` : `signal ${x.signal}`}.`, errorTail: x.errorTail };
}

/** Kill the whole process group (uv → python → sandboxed experiment subprocesses). */
function killTree(child: ChildProcess, sig: NodeJS.Signals) {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    child.kill(sig);
  }
}
