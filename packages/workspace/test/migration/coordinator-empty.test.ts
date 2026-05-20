import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationCoordinator } from "../../src/legacy/migration/coordinator.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
});

describe("MigrationCoordinator — empty registration", () => {
  it("returns no applied / no alreadyAtTarget when no pkgs are registered", async () => {
    // The schema_meta table itself should still be created so a
    // subsequent register+run can write rows without DDL setup.
    const coordinator = new MigrationCoordinator();
    const result = await coordinator.run(db);
    expect(result.applied).toEqual([]);
    expect(result.alreadyAtTarget).toEqual([]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
      .all() as { name: string }[];
    expect(tables.map((r) => r.name)).toContain("schema_meta");
  });

  it("registering a pkg with an empty migration list is a no-op (no row written)", async () => {
    const coordinator = new MigrationCoordinator();
    coordinator.register("empty-pkg", []);
    const result = await coordinator.run(db);
    expect(result.applied).toEqual([]);
    expect(result.alreadyAtTarget).toEqual([]);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM schema_meta").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
