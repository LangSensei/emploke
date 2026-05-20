import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationCoordinator } from "../../src/legacy/migration/coordinator.js";
import type { Migration } from "../../src/legacy/migration/types.js";

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

const fresh_v0v1: Migration = {
  pkg: "demo",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: `
    CREATE TABLE demo_thing (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
  `,
};

describe("MigrationCoordinator — fresh DB bootstrap (v0→v1)", () => {
  it("runs the v0→v1 migration and bumps schema_meta to 1", async () => {
    const c = new MigrationCoordinator();
    c.register("demo", [fresh_v0v1]);
    const result = await c.run(db);
    expect(result.applied).toEqual([fresh_v0v1]);
    expect(result.alreadyAtTarget).toEqual([]);
    const row = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("demo") as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(1);
    // schemaSQL ran inside the transaction so the table exists.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='demo_thing'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("is idempotent: re-running against the same DB applies no migrations", async () => {
    const c1 = new MigrationCoordinator();
    c1.register("demo", [fresh_v0v1]);
    await c1.run(db);

    const c2 = new MigrationCoordinator();
    c2.register("demo", [fresh_v0v1]);
    const result = await c2.run(db);
    expect(result.applied).toEqual([]);
    expect(result.alreadyAtTarget).toEqual(["demo"]);
  });
});
