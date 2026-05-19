import type { DatabaseSync } from "node:sqlite";
import {
  MigrationFailedError,
  MigrationRegisterError,
  MigrationVersionAheadError,
} from "./errors.js";
import { topoSort } from "./topo-sort.js";
import type { Migration, MigrationRunResult } from "./types.js";

interface RegisteredPkg {
  readonly pkg: string;
  readonly migrations: readonly Migration[];
  /** HEAD version this build expects. Equals last migration's toVersion. */
  readonly targetVersion: number;
}

/**
 * DB-level migration runner.
 *
 * Lifecycle at server startup is documented in
 * `packages/workspace/MIGRATIONS.md` — the short version is:
 *
 *   1. Construct one coordinator per SQLite connection
 *      (`global.db`, each `workspace.db`).
 *   2. `register(pkg, MIGRATIONS)` once per pkg whose tables live in
 *      that DB. Registration validates the chain shape (no gaps,
 *      no non-unit bumps, pkg name matches) so a typo at author
 *      time can never silently corrupt the DB at runtime.
 *   3. `await run(db)` once. The coordinator opens **one**
 *      `BEGIN IMMEDIATE` transaction around the entire pending set
 *      (across pkgs), so the whole batch either commits or rolls
 *      back together. `PRAGMA foreign_keys = OFF` wraps the
 *      transaction; `PRAGMA foreign_key_check` runs after each
 *      migration's `backfill` so cross-table FK integrity is
 *      verified explicitly even though deferred enforcement is off.
 *   4. Construct entity repositories. Their `ensureSchema()` is now
 *      a version-check assertion — if the coordinator was skipped,
 *      construction throws and the server fails to start (which is
 *      the desired loud failure mode).
 *
 * The coordinator is idempotent: calling `run()` twice on the same
 * DB does no work the second time because every pkg is already at
 * its target version.
 *
 * No retry / exponential backoff is built in. SQLite's `BEGIN
 * IMMEDIATE` already takes the writer lock up front (subject to
 * `busy_timeout`), so by the time `run()` returns the migration is
 * either applied or has thrown a typed error the caller can react to.
 */
export class MigrationCoordinator {
  private readonly pkgs = new Map<string, RegisteredPkg>();

  /**
   * Register a pkg's migration chain. Throws
   * {@link MigrationRegisterError} when the chain is malformed
   * (duplicate pkg, mismatched pkg name on a Migration value,
   * non-monotone fromVersion, version gap, or non-unit bump).
   *
   * Migrations are expected to start from `fromVersion = 0` — the
   * initial-schema migration of a pkg. Subsequent migrations chain
   * by `fromVersion === previous.toVersion`. Versions bump by
   * exactly one step so the coordinator can determine the
   * applicable subset by simple range comparison.
   *
   * Empty arrays are allowed and treated as "this pkg has no
   * schema". The coordinator will neither create a `schema_meta`
   * row nor complain about a missing one — useful for entity packages
   * whose persistence layout is still TBD.
   */
  register(pkg: string, migrations: readonly Migration[]): void {
    if (this.pkgs.has(pkg)) {
      throw new MigrationRegisterError(`pkg '${pkg}' is already registered`);
    }
    for (let i = 0; i < migrations.length; i++) {
      const m = migrations[i] as Migration;
      const prev = i > 0 ? (migrations[i - 1] as Migration) : undefined;
      if (m.pkg !== pkg) {
        throw new MigrationRegisterError(
          `pkg name mismatch on migration #${i}: registered as '${pkg}', migration declares '${m.pkg}'`,
        );
      }
      if (m.toVersion !== m.fromVersion + 1) {
        throw new MigrationRegisterError(
          `pkg '${pkg}' migration #${i} bumps from v${m.fromVersion} to v${m.toVersion}; must bump by exactly 1`,
        );
      }
      if (i === 0) {
        if (m.fromVersion !== 0) {
          throw new MigrationRegisterError(
            `pkg '${pkg}' first migration must start at fromVersion=0 (initial schema); got v${m.fromVersion}`,
          );
        }
      } else if (prev && m.fromVersion !== prev.toVersion) {
        throw new MigrationRegisterError(
          `pkg '${pkg}' migration #${i} starts at v${m.fromVersion}; expected v${prev.toVersion} (no gaps)`,
        );
      }
    }
    const last =
      migrations.length > 0 ? (migrations[migrations.length - 1] as Migration) : undefined;
    const targetVersion = last ? last.toVersion : 0;
    this.pkgs.set(pkg, { pkg, migrations, targetVersion });
  }

  /**
   * Run all pending migrations across all registered pkgs in one
   * `BEGIN IMMEDIATE` transaction with FK pragma management.
   * Idempotent: returns `{applied: [], alreadyAtTarget: [...]}`
   * when nothing pending.
   */
  async run(db: DatabaseSync): Promise<MigrationRunResult> {
    // schema_meta is the framework's own table and exists before any
    // pkg-level migration runs. We use a constant `IF NOT EXISTS`
    // so re-opening an already-initialised DB is a no-op. The CHECK
    // constraint is enforced even for the bootstrap insert path
    // (version is always ≥ 1 because the coordinator only writes
    // `toVersion`, which starts at 1).
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

    for (const reg of this.pkgs.values()) {
      // Pkgs with no migrations declared are a no-op — neither push
      // pending nor mark alreadyAtTarget. Lets a pkg ship empty
      // `MIGRATIONS = []` while its persistence layout is still
      // being designed without forcing it through the coordinator.
      if (reg.migrations.length === 0) continue;

      const current = currentVersions.get(reg.pkg) ?? 0;
      if (current === reg.targetVersion) {
        alreadyAtTarget.push(reg.pkg);
        continue;
      }
      if (current > reg.targetVersion) {
        throw new MigrationVersionAheadError(reg.pkg, current, reg.targetVersion);
      }
      // Pick the subset of the chain that bridges `current → target`.
      for (const m of reg.migrations) {
        if (m.fromVersion >= current && m.toVersion <= reg.targetVersion) {
          pending.push(m);
        }
      }
    }

    if (pending.length === 0) {
      return { applied: [], alreadyAtTarget };
    }

    const ordered = topoSort(pending);

    // PRAGMA foreign_keys is a connection-level toggle; we save the
    // prior setting (defaults to 0 but a caller may have flipped it
    // on for read traffic) and restore it whether the transaction
    // commits or rolls back. The `BEGIN IMMEDIATE` takes the
    // RESERVED write lock up front so a second concurrent migrator
    // waits on the file lock instead of racing to apply the same
    // migrations.
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
        if (m.backfill) await m.backfill(db);
        // `PRAGMA foreign_key_check` returns one row per violation
        // (FK pragma is off so violations don't auto-throw). We
        // surface as a real error so the whole batch rolls back —
        // a half-migrated FK graph is exactly the corruption mode
        // this coordinator exists to prevent.
        const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
        if (fkViolations.length > 0) {
          throw new Error(
            `foreign_key_check failed after ${m.pkg}:v${m.fromVersion}→v${m.toVersion}: ` +
              `${fkViolations.length} violation(s) — ${JSON.stringify(fkViolations.slice(0, 5))}`,
          );
        }
        if (m.verify) await m.verify(db);
        stmt.run(m.pkg, m.toVersion);
      }
      db.exec("COMMIT");
      inTransaction = false;
    } catch (err) {
      if (inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // best-effort — ROLLBACK on a DB whose transaction was
          // already terminated by SQLite itself (e.g. fatal error)
          // would itself throw; swallow so the original error
          // reaches the caller intact.
        }
      }
      throw new MigrationFailedError(ordered, currentMigration ?? (ordered[0] as Migration), err);
    } finally {
      // Restore the prior FK pragma. We default back to OFF if we
      // could not read the prior value (the PRAGMA returns no row
      // on some legacy SQLite builds), matching SQLite's own
      // documented default rather than silently leaving FKs on.
      db.exec(`PRAGMA foreign_keys = ${fkPrev === 1 ? "ON" : "OFF"}`);
    }

    return { applied: ordered, alreadyAtTarget };
  }
}
