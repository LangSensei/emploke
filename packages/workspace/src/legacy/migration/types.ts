import type { DatabaseSync } from "node:sqlite";

/**
 * A single forward-only schema migration for one pkg.
 *
 * The framework intentionally has **no** `down()` / reverse step —
 * downgrade is out of scope (see the architecture notes in
 * `MIGRATIONS.md`). Backup-before-migrate is also out of scope for
 * v1; the {@link MigrationCoordinator} relies on SQLite's transaction
 * ROLLBACK for mid-flight failure recovery.
 *
 * Each migration moves a pkg's schema from `fromVersion` to
 * `toVersion = fromVersion + 1`. The "bootstrap" case — a fresh
 * database with no `schema_meta` row for the pkg — is modelled as a
 * v0→v1 migration whose {@link schemaSQL} contains the initial
 * `CREATE TABLE` statements. This keeps the mental model uniform:
 * the coordinator always walks `current → target` regardless of
 * whether `current` is 0 (fresh) or N (upgrading).
 */
export interface Migration {
  /**
   * Pkg name as written to `schema_meta`. Examples: `"task"`,
   * `"session"`, `"catalog_agent"`. Must match the pkg identifier
   * passed to {@link MigrationCoordinator.register}.
   */
  readonly pkg: string;

  /**
   * Schema version this migration starts from. Use `0` for the
   * initial-schema migration of a pkg (fresh DB has no row in
   * `schema_meta`, which the coordinator treats as version 0).
   */
  readonly fromVersion: number;

  /**
   * Schema version this migration produces. Must equal
   * `fromVersion + 1` — migrations always bump by exactly one step
   * so chains are linear and the coordinator can determine the
   * applicable subset by simple range comparison.
   */
  readonly toVersion: number;

  /**
   * Cross-pkg ordering hints. Each entry is `"<pkg>:<toVersion>"`
   * naming a migration that must run **before** this one. Within a
   * single pkg the coordinator already orders by version chain
   * automatically; `dependsOn` is only needed when one pkg's
   * migration references a table or column another pkg's migration
   * creates (e.g. a FK across packages added by a later schema
   * audit).
   *
   * Omit when there is no cross-pkg dependency.
   */
  readonly dependsOn?: readonly string[];

  /**
   * Pure DDL (and optional one-shot INSERTs) executed first inside
   * the coordinator's transaction. Must NOT contain its own
   * `BEGIN` / `COMMIT` — the coordinator opens one transaction
   * around the entire pending set so all per-pkg migrations either
   * all commit or all roll back together.
   *
   * The SQL is executed via `DatabaseSync.exec` so multiple
   * statements separated by `;` are allowed.
   */
  readonly schemaSQL: string;

  /**
   * Optional application-level data transform. Runs AFTER
   * {@link schemaSQL} and BEFORE the post-migration FK check and
   * {@link verify}. Use this for cases pure SQL cannot express
   * (e.g. reading the filesystem to seed rows, resolving an opaque
   * `origin` string into a `fqn` via cross-pkg lookups, etc.).
   *
   * The callback runs inside the coordinator's single transaction —
   * any thrown error rolls back the whole batch.
   */
  readonly backfill?: (db: DatabaseSync) => void | Promise<void>;

  /**
   * Optional post-migration invariant check. Runs after
   * {@link backfill} and after the coordinator's
   * `PRAGMA foreign_key_check`, but before the `schema_meta` UPDATE.
   * Throw to roll back the entire pending batch — useful for row-
   * count assertions, FK integrity beyond what the PRAGMA detects,
   * or "no row has field X = bad-value" guards.
   */
  readonly verify?: (db: DatabaseSync) => void | Promise<void>;
}

/**
 * Outcome of a {@link MigrationCoordinator.run} call.
 *
 * - `applied` lists, in execution order, every migration that ran.
 *   Empty when the DB was already at HEAD for every registered pkg.
 * - `alreadyAtTarget` lists pkg names that were already at their
 *   declared HEAD version (no migrations needed).
 *
 * Use both for structured logging at startup so operators can see
 * exactly which pkgs were touched on this boot.
 */
export interface MigrationRunResult {
  readonly applied: readonly Migration[];
  readonly alreadyAtTarget: readonly string[];
}
