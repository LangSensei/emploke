import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/migrations.js";
import { openTestScheduleDb } from "../src/testing.js";

/**
 * Drift guard + schema introspection for `@emploke/schedule`.
 */
describe("schedules migrations-inventory", () => {
  const onDiskCount = readdirSync(join(import.meta.dirname, "..", "drizzle")).filter((f) =>
    f.endsWith(".sql"),
  ).length;

  it("MIGRATIONS has one entry per drizzle/*.sql file", () => {
    expect(MIGRATIONS.length).toBe(onDiskCount);
  });

  it("every migration has at least one non-empty SQL statement + a hash", () => {
    for (const m of MIGRATIONS) {
      expect(Array.isArray(m.sql)).toBe(true);
      expect(m.sql.length).toBeGreaterThan(0);
      expect(m.sql.some((stmt) => stmt.trim().length > 0)).toBe(true);
      expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("folderMillis is strictly monotonically increasing", () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      const prev = MIGRATIONS[i - 1];
      const curr = MIGRATIONS[i];
      if (prev && curr) {
        expect(curr.folderMillis).toBeGreaterThan(prev.folderMillis);
      }
    }
  });
});

describe("schedules schema", () => {
  let handle: ReturnType<typeof openTestScheduleDb>;
  beforeEach(() => {
    handle = openTestScheduleDb();
  });
  afterEach(() => {
    handle.close();
  });

  it("creates the schedules table", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toContain("schedules");
  });

  it("schedules table has every documented column", () => {
    const cols = handle.sqlite.prepare("PRAGMA table_info('schedules')").all() as {
      name: string;
    }[];
    const names = cols.map((c) => c.name).sort();
    // `target_agent` is dropped in migration 0001; the index is now
    // a functional partial JSON-extract over `target_json`.
    expect(names).toEqual(
      [
        "created_at",
        "enabled",
        "id",
        "last_fired_at",
        "name",
        "next_fire_at",
        "target_json",
        "target_kind",
        "trigger_expr",
        "trigger_kind",
        "trigger_tz",
        "updated_at",
      ].sort(),
    );
    // Defensive belt-and-braces: explicit assertion the dropped
    // column is gone, so a future regression that accidentally
    // re-adds it fails with a clear message.
    expect(names).not.toContain("target_agent");
  });

  it("creates the three documented indexes (target_agent_idx is now a functional partial index)", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all() as { name: string; sql?: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("schedules_enabled_idx");
    expect(names).toContain("schedules_next_fire_idx");
    expect(names).toContain("schedules_target_agent_idx");
  });

  it("schedules_target_agent_idx is a functional partial index on json_extract(target_json,'$.agent')", () => {
    const row = handle.sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='schedules_target_agent_idx'",
      )
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toMatch(/json_extract\(`?target_json`?,\s*'\$\.agent'\)/);
    expect(row!.sql).toMatch(/WHERE\s+`?target_kind`?\s*=\s*'task'/);
  });

  it("writes the journal table __drizzle_migrations_schedule", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__drizzle%'")
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toContain("__drizzle_migrations_schedule");
  });
});
