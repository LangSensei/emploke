import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationCoordinator } from "../../src/migration/coordinator.js";
import type { Migration } from "../../src/migration/types.js";

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

const v0v1: Migration = {
  pkg: "demo",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: "CREATE TABLE demo (id INTEGER PRIMARY KEY);",
};

const v1v2: Migration = {
  pkg: "demo",
  fromVersion: 1,
  toVersion: 2,
  schemaSQL: "ALTER TABLE demo ADD COLUMN extra TEXT;",
};

describe("MigrationCoordinator — already at target", () => {
  it("reports the pkg as alreadyAtTarget without running any migration", async () => {
    // Seed at v2 (HEAD): no migration should run.
    db.exec(`
      CREATE TABLE schema_meta (pkg TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL CHECK (version > 0));
      CREATE TABLE demo (id INTEGER PRIMARY KEY, extra TEXT);
      INSERT INTO schema_meta (pkg, version) VALUES ('demo', 2);
    `);

    const c = new MigrationCoordinator();
    c.register("demo", [v0v1, v1v2]);
    const result = await c.run(db);

    expect(result.applied).toEqual([]);
    expect(result.alreadyAtTarget).toEqual(["demo"]);
    const row = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("demo") as {
      version: number;
    };
    expect(row.version).toBe(2);
  });
});
