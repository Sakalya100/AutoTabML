// Apply web/db/migrations/*.sql to Postgres (Neon), in name order, each exactly once.
//
//   npm run db:migrate            (reads DATABASE_URL from web/.env.local or the environment)
//   npm run db:migrate -- --list  (also print the public tables afterwards)
//
// Idempotent: applied files are recorded in schema_migrations(name, checksum, applied_at); a file whose checksum
// changed after it was applied is an error (write a new migration instead). Each file runs in one transaction over a
// WebSocket Client (the HTTP driver can't run multi-statement SQL). The connection string is never printed.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@neondatabase/serverless";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../db/migrations");
const url = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL_POOLED;
if (!url) {
  console.error("db:migrate: DATABASE_URL is not set (web/.env.local or the environment).");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query(`create table if not exists schema_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const done = new Map((await client.query("select name, checksum from schema_migrations")).rows.map((r) => [r.name, r.checksum]));
  const files = readdirSync(dir).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
  let applied = 0;
  for (const f of files) {
    const sql = readFileSync(resolve(dir, f), "utf8");
    const sum = createHash("sha256").update(sql).digest("hex");
    if (done.has(f)) {
      if (done.get(f) !== sum) throw new Error(`${f} changed after it was applied; add a new migration instead`);
      continue;
    }
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [f, sum]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw new Error(`${f}: ${err.message}`);
    }
    console.log(`applied ${f}`);
    applied++;
  }
  console.log(applied ? `${applied} migration(s) applied` : "up to date");
  if (process.argv.includes("--list")) {
    const { rows } = await client.query(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    console.log("tables: " + rows.map((r) => r.table_name).join(", "));
  }
} finally {
  await client.end();
}
