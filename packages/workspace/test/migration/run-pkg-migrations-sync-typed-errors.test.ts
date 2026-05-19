import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationRegisterError, MigrationVersionAheadError } from "../../src/migration/errors.js";
import { runPkgMigrationsSync } from "../../src/migration/run-pkg-migrations.js";
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

describe("runPkgMigrationsSync — typed error parity with async run()", () => {
  // Pins the sync-vs-async error-type symmetry fix: every condition
  // the async `MigrationCoordinator.run()` raises with a typed error
  // must surface the SAME typed class from `runPkgMigrationsSync` so
  // consumers (test fixtures, downstream migration tools) can write
  // a single `instanceof MigrationError` handler that works on both
  // code paths.
  it("throws MigrationVersionAheadError when the DB is at a higher version than the chain produces", () => {
    db.exec(`
      CREATE TABLE schema_meta (pkg TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL CHECK (version > 0));
      CREATE TABLE demo (id INTEGER PRIMARY KEY);
      INSERT INTO schema_meta (pkg, version) VALUES ('demo', 3);
    `);

    expect(() => runPkgMigrationsSync(db, [{ pkg: "demo", migrations: [v0v1, v1v2] }])).toThrow(
      MigrationVersionAheadError,
    );
  });

  it("throws MigrationRegisterError when a registered migration declares a backfill hook (sync-runner restriction)", () => {
    // The async coordinator allows backfill/verify hooks; the sync
    // variant must refuse them because it has no await point.
    // Surface as the same `MigrationError` family so consumers don't
    // have to branch on framework-misuse-vs-runtime-fault.
    const v0v1WithBackfill: Migration = {
      pkg: "demo",
      fromVersion: 0,
      toVersion: 1,
      schemaSQL: "CREATE TABLE demo (id INTEGER PRIMARY KEY);",
      backfill: async () => {
        /* would never run synchronously */
      },
    };
    expect(() =>
      runPkgMigrationsSync(db, [{ pkg: "demo", migrations: [v0v1WithBackfill] }]),
    ).toThrow(MigrationRegisterError);
  });

  it("throws MigrationRegisterError when a registered migration declares a verify hook (sync-runner restriction)", () => {
    const v0v1WithVerify: Migration = {
      pkg: "demo",
      fromVersion: 0,
      toVersion: 1,
      schemaSQL: "CREATE TABLE demo (id INTEGER PRIMARY KEY);",
      verify: async () => {
        /* would never run synchronously */
      },
    };
    expect(() => runPkgMigrationsSync(db, [{ pkg: "demo", migrations: [v0v1WithVerify] }])).toThrow(
      MigrationRegisterError,
    );
  });
});
