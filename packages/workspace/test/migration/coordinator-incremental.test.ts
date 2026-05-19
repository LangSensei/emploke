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
  schemaSQL: "CREATE TABLE demo (id INTEGER PRIMARY KEY, label TEXT NOT NULL);",
};

const v1v2: Migration = {
  pkg: "demo",
  fromVersion: 1,
  toVersion: 2,
  schemaSQL: "ALTER TABLE demo ADD COLUMN extra TEXT;",
};

describe("MigrationCoordinator — incremental upgrade", () => {
  it("starting from a v1 DB, the v1→v2 migration runs and v0→v1 is skipped", async () => {
    // Seed the DB at v1: create the v1-shape table directly and
    // insert the schema_meta row that v0→v1 would otherwise have
    // written. The coordinator's pending-set logic must NOT re-run
    // v0→v1 (which would fail with a CREATE TABLE on an existing
    // table — without IF NOT EXISTS).
    db.exec(`
      CREATE TABLE schema_meta (pkg TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL CHECK (version > 0));
      CREATE TABLE demo (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
      INSERT INTO schema_meta (pkg, version) VALUES ('demo', 1);
    `);

    const c = new MigrationCoordinator();
    c.register("demo", [v0v1, v1v2]);
    const result = await c.run(db);

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toBe(v1v2);
    expect(result.alreadyAtTarget).toEqual([]);
    const row = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("demo") as {
      version: number;
    };
    expect(row.version).toBe(2);
    // The v1→v2 ALTER ran: extra column exists.
    const cols = db.prepare("PRAGMA table_info(demo)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("extra");
  });
});
