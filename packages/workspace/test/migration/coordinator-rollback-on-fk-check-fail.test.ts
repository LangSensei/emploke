import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationCoordinator } from "../../src/migration/coordinator.js";
import { MigrationFailedError } from "../../src/migration/errors.js";
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

// Two pkgs: a parent and a child. The child's table has a FK into
// the parent. Backfill inserts a child row pointing at a parent row
// that doesn't exist — a dangling FK. With `PRAGMA foreign_keys =
// OFF` (which the coordinator sets around the transaction) the
// dangling row would be permitted silently. The coordinator's
// explicit `PRAGMA foreign_key_check` after backfill must catch it.

const parentV0V1: Migration = {
  pkg: "parent",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: "CREATE TABLE parent (id INTEGER PRIMARY KEY);",
};

const childV0V1: Migration = {
  pkg: "child",
  fromVersion: 0,
  toVersion: 1,
  // Cross-pkg ordering so parent runs first; we want parent table to
  // exist when child is created.
  dependsOn: ["parent:1"],
  schemaSQL: `
    CREATE TABLE child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parent(id)
    );
  `,
  backfill: async (db) => {
    // Insert a child row pointing at a non-existent parent. FK pragma
    // is off so the insert itself succeeds; the coordinator's
    // foreign_key_check will catch it after backfill.
    db.prepare("INSERT INTO child (id, parent_id) VALUES (?, ?)").run(1, 999);
  },
};

describe("MigrationCoordinator — rollback on FK check failure", () => {
  it("PRAGMA foreign_key_check catches a dangling FK introduced by backfill, rollback restores empty DB", async () => {
    const c = new MigrationCoordinator();
    c.register("parent", [parentV0V1]);
    c.register("child", [childV0V1]);
    await expect(c.run(db)).rejects.toBeInstanceOf(MigrationFailedError);

    // No schema_meta row was bumped because the transaction rolled
    // back. Even the parent's bump didn't commit because every
    // pending migration runs inside the same transaction.
    const rows = db.prepare("SELECT pkg, version FROM schema_meta").all() as {
      pkg: string;
      version: number;
    }[];
    expect(rows).toEqual([]);

    // child table also doesn't exist (rolled back).
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('parent','child')")
      .all() as { name: string }[];
    expect(tables).toEqual([]);
  });
});
