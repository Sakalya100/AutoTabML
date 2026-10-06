/**
 * Vercel Sandbox runner — UNTESTED. Written against the @vercel/sandbox 3.x API and the Vercel Sandbox docs
 * (fetched 2026-10-06), but never executed: no Vercel credentials were available. Treat as a starting point.
 *
 * Why it is shaped this way: a route handler cannot live for the length of a run (Hobby sandboxes may run
 * 45 min, Pro 24 h), so nothing in this process tails the engine. Instead:
 *
 *   POST /api/runs ─► after(): Sandbox.create → install engine → upload CSV + run.sh + forward.py
 *                     → lock the firewall down → runCommand({ detached: true }) → return
 *   in the sandbox:   python -m autotinker evolve … --events-stdout | python forward.py
 *                     forward.py POSTs batches of JSONL to /api/runs/<id>/ingest (Bearer per-run token),
 *                     then posts the exit code, a redacted stderr tail and run.json.
 *   UI:               GET /api/runs/<id>/stream tails the Store (Redis in production), never the sandbox.
 *   cancel:           Sandbox.get({ name }).stop()
 *
 * BYOK: the Anthropic key never enters the sandbox. The firewall's credentials brokering injects the
 * `x-api-key` header on requests to api.anthropic.com; the engine only sees a placeholder env var.
 *
 * Env: AUTOTINKER_PUBLIC_URL (or VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL) — the URL the sandbox posts events to;
 *      AUTOTINKER_SANDBOX_PACKAGE — pip spec for the engine (default: the GitHub v2 branch);
 *      AUTOTINKER_SANDBOX_TIMEOUT_MS — session timeout (default 45 min = the Hobby maximum; Pro allows up to 24 h);
 *      AUTOTINKER_SANDBOX_VCPUS (default 2; 2 GB RAM per vCPU). Auth: VERCEL_OIDC_TOKEN (automatic on Vercel).
 * Deployment Protection must allow the ingest route (or set a protection-bypass secret) for previews.
 */
import { randomBytes } from "node:crypto";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { sha256 } from "../api";
import { getStore } from "../store";
import type { RunMeta } from "../store/types";
import { engineArgs, type Runner, type StartOptions } from "./types";

const WORKDIR = "/vercel/sandbox";
const DEFAULT_PACKAGE = "autotinker @ git+https://github.com/Sakalya100/AutoTabML@v2";
const INSTALL_HOSTS = ["pypi.org", "files.pythonhosted.org", "github.com", "*.githubusercontent.com", "astral.sh", "*.astral.sh"];

function publicUrl(): string {
  const raw = process.env.AUTOTINKER_PUBLIC_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (!raw) throw new Error("AUTOTINKER_PUBLIC_URL is not set; the sandbox has nowhere to send events");
  return raw.startsWith("http") ? raw.replace(/\/$/, "") : `https://${raw}`;
}

// Runs inside the sandbox. stdlib only. Reads JSONL on stdin, POSTs batches; `--final` posts exit + record.
const FORWARD_PY = String.raw`
import json, os, sys, time, urllib.request
URL = os.environ["AUTOTINKER_INGEST_URL"]; TOKEN = os.environ["AUTOTINKER_INGEST_TOKEN"]
def post(body, kind):
    for i in range(5):
        try:
            req = urllib.request.Request(URL + "?kind=" + kind, data=body.encode(), method="POST",
                headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/x-ndjson"})
            urllib.request.urlopen(req, timeout=20).read(); return
        except Exception as e:
            sys.stderr.write("ingest retry %d: %s\n" % (i, e)); time.sleep(1.5 * (i + 1))
if len(sys.argv) > 1 and sys.argv[1] == "--final":
    code, err, rec = sys.argv[2], sys.argv[3], sys.argv[4]
    tail = open(err, errors="replace").read().splitlines()[-40:] if os.path.exists(err) else []
    post(json.dumps({"exit_code": int(code), "stderr_tail": "\n".join(tail)}), "exit")
    if os.path.exists(rec): post(open(rec).read(), "record")
    sys.exit(0)
buf, last = [], time.time()
for line in sys.stdin:
    if line.strip(): buf.append(line.rstrip("\n"))
    if buf and (len(buf) >= 20 or time.time() - last > 1.0):
        post("\n".join(buf), "events"); buf, last = [], time.time()
if buf: post("\n".join(buf), "events")
`;

export class VercelSandboxRunner implements Runner {
  readonly kind = "vercel-sandbox" as const;

  async start({ meta, csv, llmSpec, apiKey }: StartOptions): Promise<void> {
    const store = getStore();
    const token = randomBytes(32).toString("hex");
    const appHost = new URL(publicUrl()).host;
    await store.updateMeta(meta.id, { status: "starting", ingestTokenSha256: sha256(token) });

    const timeout = Number(process.env.AUTOTINKER_SANDBOX_TIMEOUT_MS ?? 45 * 60 * 1000);
    let sandbox: Sandbox | null = null;
    try {
      // Install phase: only package indexes and GitHub are reachable.
      sandbox = await Sandbox.create({
        name: `autotinker-${meta.id}`,
        resources: { vcpus: Number(process.env.AUTOTINKER_SANDBOX_VCPUS ?? 2) },
        timeout,
        persistent: false,
        networkPolicy: { allow: INSTALL_HOSTS },
        tags: { app: "autotinker", run: meta.id },
      });
      await store.updateMeta(meta.id, { sandboxName: sandbox.name });

      // The default image (vercel/sandbox/universal) ships Python 3.14; the ML stack is pinned to 3.12 via uv.
      const pkg = process.env.AUTOTINKER_SANDBOX_PACKAGE || DEFAULT_PACKAGE;
      const install = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", `python3 -m pip install -q --user uv && ~/.local/bin/uv venv -q --python 3.12 ${WORKDIR}/.venv && ~/.local/bin/uv pip install -q --python ${WORKDIR}/.venv/bin/python "${pkg}"`],
        cwd: WORKDIR,
      });
      if (install.exitCode !== 0) {
        const tail = (await install.stderr()).split("\n").slice(-30).join("\n");
        throw Object.assign(new Error("Installing the engine in the sandbox failed."), { tail });
      }

      const args = engineArgs({ csvPath: `${WORKDIR}/input.csv`, target: meta.target, llmSpec, maxExperiments: meta.maxExperiments, outDir: `${WORKDIR}/out`, description: meta.description });
      const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
      const runSh = `#!/bin/bash
set -o pipefail
cd ${WORKDIR}
.venv/bin/python ${quoted} 2> stderr.log | .venv/bin/python forward.py
code=$?
.venv/bin/python forward.py --final "$code" stderr.log out/run.json
`;
      await sandbox.writeFiles([
        { path: `${WORKDIR}/input.csv`, content: csv },
        { path: `${WORKDIR}/forward.py`, content: Buffer.from(FORWARD_PY) },
        { path: `${WORKDIR}/run.sh`, content: Buffer.from(runSh), mode: 0o755 },
      ]);

      // Run phase: lock egress down to our ingest host (+ Anthropic with the key brokered at the firewall).
      const allow: Record<string, { transform?: { headers: Record<string, string> }[] }[]> = { [appHost]: [] };
      const key = apiKey || (meta.llm === "anthropic" ? process.env.AUTOTINKER_SERVER_ANTHROPIC_KEY : undefined);
      if (meta.llm === "anthropic" && key) allow["api.anthropic.com"] = [{ transform: [{ headers: { "x-api-key": key } }] }];
      await sandbox.update({ networkPolicy: { allow } as NetworkPolicy });

      const cmd = await sandbox.runCommand({
        cmd: "bash",
        args: [`${WORKDIR}/run.sh`],
        cwd: WORKDIR,
        detached: true,
        env: {
          AUTOTINKER_INGEST_URL: `${publicUrl()}/api/runs/${meta.id}/ingest`,
          AUTOTINKER_INGEST_TOKEN: token,
          PYTHONUNBUFFERED: "1",
          // Placeholder so the SDK client initialises; the real key is injected by the firewall.
          ...(meta.llm === "anthropic" ? { ANTHROPIC_API_KEY: "brokered-by-vercel-firewall" } : {}),
        },
      });
      await store.updateMeta(meta.id, { status: "running", commandId: cmd.cmdId });
    } catch (err) {
      const e = err as Error & { tail?: string };
      console.error(`[run ${meta.id}] sandbox start failed: ${e.message}`);
      await store.updateMeta(meta.id, { status: "failed", error: e.message || "Could not start the sandbox.", errorTail: e.tail, finishedAt: new Date().toISOString() });
      await sandbox?.stop().catch(() => undefined);
    }
  }

  async cancel(meta: RunMeta): Promise<boolean> {
    if (!meta.sandboxName) return false;
    const sandbox = await Sandbox.get({ name: meta.sandboxName, resume: false });
    await sandbox.stop();
    return true;
  }
}
