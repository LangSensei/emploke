import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationCoordinator } from "../../src/legacy/migration/coordinator.js";
import { MigrationFailedError } from "../../src/legacy/migration/errors.js";
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

const v0v1: Migration = {
  pkg: "demo",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: "CREATE TABLE demo (id INTEGER PRIMARY KEY);",
};

const v1v2_verify_throws: Migration = {
  pkg: "demo",
  fromVersion: 1,
  toVersion: 2,
  schemaSQL: "ALTER TABLE demo ADD COLUMN extra TEXT;",
  verify: async () => {
    throw new Error("simulated invariant violation");
  },
};

describe("MigrationCoordinator — rollback on verify failure", () => {
  it("rolls back so the schemaSQL change is reverted and schema_meta is not bumped", async () => {
    {
      const c = new MigrationCoordinator();
      c.register("demo", [v0v1]);
      await c.run(db);
    }
    const c = new MigrationCoordinator();
    c.register("demo", [v0v1, v1v2_verify_throws]);
    await expect(c.run(db)).rejects.toBeInstanceOf(MigrationFailedError);

    const versionAfter = (
      db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("demo") as {
        version: number;
      }
    ).version;
    expect(versionAfter).toBe(1);
    const cols = db.prepare("PRAGMA table_info(demo)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain("extra");
  });
});
