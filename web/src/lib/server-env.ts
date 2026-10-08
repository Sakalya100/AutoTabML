/**
 * Server-only access to provider keys and engine settings.
 *
 * `next dev` only loads web/.env*, but the engine's keys live in the repo-root .env. Locally (not on Vercel) we read
 * that file once and pick ONLY the allow-listed names below — never DATABASE_URL or anything else. Values are never
 * logged. On Vercel the same names come from the project's environment variables.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** LLM provider keys the engine (and the preview's one suggestion call) may use. */
export const PROVIDER_KEYS = ["GROQ_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY"] as const;
/** Engine settings passed through: AUTOTINKER_* minus anything that looks like a credential. */
const ENGINE_SETTING = /^AUTOTINKER_[A-Z0-9_]+$/;
const CREDENTIAL = /(KEY|TOKEN|SECRET|PASSWORD|DATABASE)/;

let rootEnv: Record<string, string> | null = null;

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/** The repo-root .env, filtered to provider keys + engine settings. Empty on Vercel or if the file is missing. */
function repoEnv(): Record<string, string> {
  if (rootEnv) return rootEnv;
  rootEnv = {};
  if (process.env.VERCEL) return rootEnv;
  try {
    const all = parseDotenv(readFileSync(path.resolve(process.cwd(), "..", ".env"), "utf8"));
    for (const [k, v] of Object.entries(all))
      if ((PROVIDER_KEYS as readonly string[]).includes(k) || (ENGINE_SETTING.test(k) && !CREDENTIAL.test(k))) rootEnv[k] = v;
  } catch {}
  return rootEnv;
}

/** process.env wins over the repo-root .env. */
export function serverEnv(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : repoEnv()[name];
}

/** Provider keys + AUTOTINKER_* engine settings for the engine process. Never DATABASE_URL or other credentials. */
export function engineEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const names = new Set<string>([...Object.keys(repoEnv()), ...Object.keys(process.env)]);
  for (const k of names) {
    const isProvider = (PROVIDER_KEYS as readonly string[]).includes(k);
    if (!isProvider && !(ENGINE_SETTING.test(k) && !CREDENTIAL.test(k))) continue;
    const v = serverEnv(k);
    if (v) out[k] = v;
  }
  return out;
}

/** Every secret value we know of, for redacting logs. */
export function knownSecrets(): string[] {
  const own = ["AUTOTINKER_SESSION_SECRET", "DATABASE_URL", "DATABASE_URL_POOLED", "DATABASE_URL_UNPOOLED"].map((k) => process.env[k]);
  return [...PROVIDER_KEYS.map((k) => serverEnv(k)), ...own].filter((v): v is string => !!v);
}

export const _test = { parseDotenv };
