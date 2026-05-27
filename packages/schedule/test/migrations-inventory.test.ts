import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/migrations.js";
import { openTestScheduleDb } from "../src/testing.js";

/**
 * Drift guard + schema introspection for `@emploke/schedule`. Mirrors
 * `packages/workflow/test/schema.test.ts` so reviewers can compare
 * file-for-file across entity pkgs.
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
    expect(names).toEqual(
      [
        "created_at",
        "enabled",
        "id",
        "last_fired_at",
        "name",
        "next_fire_at",
        "target_agent",
        "target_json",
        "target_kind",
        "trigger_expr",
        "trigger_kind",
        "trigger_tz",
        "updated_at",
      ].sort(),
    );
  });

  it("creates the three documented indexes", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("schedules_enabled_idx");
    expect(names).toContain("schedules_next_fire_idx");
    expect(names).toContain("schedules_target_agent_idx");
  });

  it("writes the journal table __drizzle_migrations_schedule", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__drizzle%'")
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toContain("__drizzle_migrations_schedule");
  });
});
