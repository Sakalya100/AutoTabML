import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSERT_EVENTS_SQL } from "@/lib/db/repo";

const dir = path.join(__dirname, "..", "db", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const sql = files.map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n").toLowerCase();

describe("migrations", () => {
  it("are numbered, ordered files", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^\d{3}_[\w-]+\.sql$/);
  });

  it("create every table idempotently and never drop anything", () => {
    for (const t of ["owners", "sessions", "runs", "run_events", "messages"]) expect(sql).toContain(`create table if not exists ${t} (`);
    expect(sql).not.toMatch(/\bdrop\s+(table|schema|index|column)\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    const creates = sql.match(/create (unique )?(table|index)\b/g) ?? [];
    const guarded = sql.match(/create (unique )?(table|index) if not exists\b/g) ?? [];
    expect(guarded.length).toBe(creates.length);
  });

  it("keys events by (run_id, seq) and indexes owner -> sessions and session -> runs/messages", () => {
    expect(sql).toMatch(/primary key \(run_id, seq\)/);
    expect(sql).toMatch(/on sessions \(owner_id, updated_at desc\)/);
    expect(sql).toMatch(/on runs \(session_id, created_at\)/);
    expect(sql).toMatch(/on messages \(session_id, created_at\)/);
  });

  it("constrains roles, kinds and statuses, and cascades from owner down", () => {
    expect(sql).toMatch(/role\s+text not null check \(role in \('user', 'system'\)\)/);
    expect(sql).toMatch(/kind\s+text not null default 'chat' check \(kind in \('chat', 'steer', 'control'\)\)/);
    expect(sql).toContain("'queued', 'starting', 'running', 'finished', 'failed', 'cancelled'");
    expect(sql).toMatch(/owner_id\s+text not null references owners \(id\) on delete cascade/);
    expect(sql).toMatch(/session_id\s+text not null references sessions \(id\) on delete cascade/);
    expect(sql).toMatch(/run_id\s+text not null references runs \(id\) on delete cascade/);
  });

  it("event inserts are idempotent and parameterised", () => {
    expect(INSERT_EVENTS_SQL.toLowerCase()).toContain("on conflict (run_id, seq) do nothing");
    expect(INSERT_EVENTS_SQL).toMatch(/unnest\(\$1::text\[\], \$2::int\[\], \$3::text\[\], \$4::text\[\], \$5::text\[\]\)/);
  });
});
