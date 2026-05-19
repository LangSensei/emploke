import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationCoordinator } from "../../src/migration/coordinator.js";
import { MigrationVersionAheadError } from "../../src/migration/errors.js";
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

describe("MigrationCoordinator — downgrade blocked", () => {
  it("throws MigrationVersionAheadError when the DB is at a higher version than the code's chain produces", async () => {
    // Seed DB at v3 but code only ships migrations through v2.
    // Forward-only: the coordinator must refuse to silently
    // downgrade and surface a typed error so the operator can
    // upgrade the binary.
    db.exec(`
      CREATE TABLE schema_meta (pkg TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL CHECK (version > 0));
      CREATE TABLE demo (id INTEGER PRIMARY KEY);
      INSERT INTO schema_meta (pkg, version) VALUES ('demo', 3);
    `);

    const c = new MigrationCoordinator();
    c.register("demo", [v0v1, v1v2]);
    await expect(c.run(db)).rejects.toBeInstanceOf(MigrationVersionAheadError);
  });
});
