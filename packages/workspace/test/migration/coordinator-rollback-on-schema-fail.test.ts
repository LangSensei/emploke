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

const v1v2_bad: Migration = {
  pkg: "demo",
  fromVersion: 1,
  toVersion: 2,
  // Deliberate syntax error so DDL execution throws.
  schemaSQL: "ALTER TABLE demo ADD COLUMN extra TEXT NOT NULL INVALID_SYNTAX_TOKEN;",
};

describe("MigrationCoordinator — rollback on schemaSQL failure", () => {
  it("rolls back the transaction so the DB is unchanged and schema_meta is not bumped", async () => {
    // Apply v0→v1 first (in a separate run) so v1v2 has data to
    // operate on. We then try a second run that exercises only the
    // failing migration.
    {
      const c = new MigrationCoordinator();
      c.register("demo", [v0v1]);
      await c.run(db);
    }
    const versionBefore = (
      db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("demo") as {
        version: number;
      }
    ).version;
    expect(versionBefore).toBe(1);

    const c = new MigrationCoordinator();
    c.register("demo", [v0v1, v1v2_bad]);
    await expect(c.run(db)).rejects.toBeInstanceOf(MigrationFailedError);

    // schema_meta unchanged — the failure rolled back the version bump.
    const versionAfter = (
      db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("demo") as {
        version: number;
      }
    ).version;
    expect(versionAfter).toBe(1);

    // No `extra` column was added because the transaction rolled back.
    const cols = db.prepare("PRAGMA table_info(demo)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain("extra");
  });
});
