import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/migrations.js";

/**
 * Drift guard: if `pnpm db:generate` produces a new `*.sql` in
 * `drizzle/`, you must add a matching `?raw` import + `meta(...)`
 * entry in `src/migrations.ts`. This test fails loudly when the two
 * go out of sync.
 *
 * Shape assertions check the `MigrationMeta` invariants that drizzle's
 * official applier relies on (non-empty `sql`/`hash`, monotonic
 * `folderMillis`).
 */
describe("migrations-inventory", () => {
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
