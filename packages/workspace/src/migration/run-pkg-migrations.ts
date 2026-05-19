import type { DatabaseSync } from "node:sqlite";
import { MigrationCoordinator } from "./coordinator.js";
import {
  MigrationFailedError,
  MigrationRegisterError,
  MigrationVersionAheadError,
} from "./errors.js";
import { topoSort } from "./topo-sort.js";
import type { Migration, MigrationRunResult } from "./types.js";

/**
 * Convenience helper that registers a set of pkg/migration pairs
 * against a fresh {@link MigrationCoordinator} and runs them. The
 * server's startup wiring uses this; tests use it too so they don't
 * have to reproduce the register-then-run boilerplate.
 *
 * Returns the coordinator's result so callers can log
 * `applied.length` / `alreadyAtTarget` at startup.
 */
export async function runPkgMigrations(
  db: DatabaseSync,
  registrations: readonly { readonly pkg: string; readonly migrations: readonly Migration[] }[],
): Promise<MigrationRunResult> {
  const coordinator = new MigrationCoordinator();
  for (const { pkg, migrations } of registrations) {
    coordinator.register(pkg, migrations);
  }
  return coordinator.run(db);
}

/**
 * Synchronous variant of {@link runPkgMigrations} for test setup
 * where every migration in the registered set has no `backfill` /
 * `verify` step. Throws if any `backfill` / `verify` is supplied —
 * the test fixture should use the async {@link runPkgMigrations} in
 * that case instead.
 *
 * Exists so existing synchronous test fixtures (e.g. `makeRepo()`
 * in `packages/task/test/manager.test.ts`, called from dozens of
 * synchronous helpers) don't have to be reworked into the async
 * path just to bootstrap a `:memory:` DB.
 *
 * Reimplements the coordinator's transaction logic synchronously
 * (no async/await microtask hops) so the call returns with the DB
 * fully migrated. Behaviour mirrors the async version exactly for
 * the no-hook case: same `schema_meta` bootstrap, same
 * single-transaction semantics, same `PRAGMA foreign_keys` /
 * `PRAGMA foreign_key_check` discipline.
 *
 * Uses {@link MigrationCoordinator.register} for input validation
 * (duplicate pkgs, monotone versions, etc.) before running, so
 * malformed registrations surface the same typed errors here as on
 * the async path.
 */
export function runPkgMigrationsSync(
  db: DatabaseSync,
  registrations: readonly { readonly pkg: string; readonly migrations: readonly Migration[] }[],
): MigrationRunResult {
  const coordinator = new MigrationCoordinator();
  for (const { pkg, migrations } of registrations) {
    coordinator.register(pkg, migrations);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      pkg     TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0)
    );
  `);
  const currentVersions = new Map<string, number>();
  for (const row of db.prepare("SELECT pkg, version FROM schema_meta").all() as {
    pkg: string;
    version: number;
  }[]) {
    currentVersions.set(row.pkg, row.version);
  }

  const pending: Migration[] = [];
  const alreadyAtTarget: string[] = [];
  for (const { pkg, migrations } of registrations) {
    if (migrations.length === 0) continue;
    const targetVersion = (migrations[migrations.length - 1] as Migration).toVersion;
    const current = currentVersions.get(pkg) ?? 0;
    if (current === targetVersion) {
      alreadyAtTarget.push(pkg);
      continue;
    }
    if (current > targetVersion) {
      // Mirror the async coordinator's typed error so consumers can
      // `instanceof MigrationVersionAheadError` uniformly across both
      // code paths.
      throw new MigrationVersionAheadError(pkg, current, targetVersion);
    }
    for (const m of migrations) {
      if (m.fromVersion >= current && m.toVersion <= targetVersion) pending.push(m);
    }
  }

  if (pending.length === 0) {
    return { applied: [], alreadyAtTarget };
  }

  const ordered = topoSort(pending);
  for (const m of ordered) {
    if (m.backfill || m.verify) {
      // Sync-runner-specific restriction: hooks aren't compatible
      // with the no-await contract this helper offers. Surface as a
      // typed `MigrationRegisterError` so it lands in the same
      // `instanceof MigrationError` bucket as every other framework
      // misuse signal (chain gaps, duplicate pkgs, …) and never as
      // a raw `Error` that a consumer's catch-MigrationError block
      // would miss.
      throw new MigrationRegisterError(
        `runPkgMigrationsSync: migration ${m.pkg}:v${m.fromVersion}→v${m.toVersion} ` +
          `declares a backfill/verify hook. Use the async runPkgMigrations helper instead.`,
      );
    }
  }

  const fkPrev = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined)
    ?.foreign_keys;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  let inTransaction = true;
  let currentMigration: Migration | null = null;
  try {
    const stmt = db.prepare(`
      INSERT INTO schema_meta (pkg, version) VALUES (?, ?)
      ON CONFLICT(pkg) DO UPDATE SET version = excluded.version
    `);
    for (const m of ordered) {
      currentMigration = m;
      db.exec(m.schemaSQL);
      const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
      if (fkViolations.length > 0) {
        throw new Error(
          `foreign_key_check failed after ${m.pkg}:v${m.fromVersion}→v${m.toVersion}: ` +
            `${fkViolations.length} violation(s) — ${JSON.stringify(fkViolations.slice(0, 5))}`,
        );
      }
      stmt.run(m.pkg, m.toVersion);
    }
    db.exec("COMMIT");
    inTransaction = false;
  } catch (err) {
    if (inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best-effort
      }
    }
    throw new MigrationFailedError(ordered, currentMigration ?? (ordered[0] as Migration), err);
  } finally {
    db.exec(`PRAGMA foreign_keys = ${fkPrev === 1 ? "ON" : "OFF"}`);
  }

  return { applied: ordered, alreadyAtTarget };
}
