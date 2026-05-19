import type { Migration } from "./types.js";

/**
 * Base class for every error raised by the migration framework.
 * Callers who only need a coarse "is this a migration failure?"
 * check can `instanceof` this; specific subclasses below carry
 * richer typed context.
 */
export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "MigrationError";
  }
}

/**
 * Raised when {@link MigrationCoordinator.register} is given a
 * malformed migration list — wrong pkg name on a Migration value,
 * non-monotone versions, version gaps, or a non-unit version bump.
 * Surfaces at process startup so a typo can never silently corrupt
 * a database at runtime.
 */
export class MigrationRegisterError extends MigrationError {
  constructor(message: string) {
    super(message);
    this.name = "MigrationRegisterError";
  }
}

/**
 * Raised when the on-disk schema version for a pkg is **newer**
 * than the latest version this build's migration chain produces.
 * Forward-only framework: there is no `down()` to roll the DB back
 * to a version this binary can talk to, so the operator must
 * upgrade the binary instead. Distinct from
 * {@link MigrationFailedError} because the remedy is different
 * (operator action, not retry).
 */
export class MigrationVersionAheadError extends MigrationError {
  constructor(
    public readonly pkg: string,
    public readonly dbVersion: number,
    public readonly codeVersion: number,
  ) {
    super(
      `pkg '${pkg}' is at v${dbVersion} on disk; this build only ships migrations up to v${codeVersion}. ` +
        `Downgrade is not supported — upgrade the server.`,
    );
    this.name = "MigrationVersionAheadError";
  }
}

/**
 * Raised when one of the pending migrations threw during
 * {@link Migration.schemaSQL}, {@link Migration.backfill},
 * `PRAGMA foreign_key_check`, or {@link Migration.verify}. The
 * coordinator has already issued `ROLLBACK` by the time this is
 * thrown — the DB is back at the pre-migration state for every
 * pkg in the batch.
 *
 * `attempted` is the full ordered batch the coordinator was running
 * (not just the failing one) so operators can reproduce the exact
 * scenario in a test fixture if needed. `cause` is the original
 * thrown value preserved via `Error.cause`.
 */
export class MigrationFailedError extends MigrationError {
  constructor(
    public readonly attempted: readonly Migration[],
    public readonly failing: Migration,
    cause: unknown,
  ) {
    super(
      `migration ${failing.pkg}: v${failing.fromVersion}→v${failing.toVersion} failed; ` +
        `transaction rolled back (${attempted.length} migration(s) in batch)`,
      { cause },
    );
    this.name = "MigrationFailedError";
  }
}

/**
 * Raised by `topoSort` when {@link Migration.dependsOn} declarations
 * form a cycle the coordinator cannot satisfy. Surfaces at process
 * startup — a cyclic dependency graph is a programmer error, never
 * a recoverable condition.
 *
 * `remaining` lists the migrations the algorithm could not place;
 * they collectively form one or more cycles.
 */
export class MigrationCycleError extends MigrationError {
  constructor(public readonly remaining: readonly Migration[]) {
    const labels = remaining.map((m) => `${m.pkg}:v${m.fromVersion}→v${m.toVersion}`).join(", ");
    super(`migration dependency cycle detected among: ${labels}`);
    this.name = "MigrationCycleError";
  }
}

/**
 * Raised by `topoSort` when a migration's {@link Migration.dependsOn}
 * references a node (`"<pkg>:<toVersion>"`) that does not exist in
 * the pending set. Either the referenced pkg is not registered, or
 * the referenced migration has already been applied (so it isn't
 * pending). Surfaces at startup because either case indicates a
 * mis-authored migration file.
 */
export class MigrationDependencyMissingError extends MigrationError {
  constructor(
    public readonly migration: Migration,
    public readonly missing: string,
  ) {
    super(
      `migration ${migration.pkg}:v${migration.fromVersion}→v${migration.toVersion} ` +
        `declares dependsOn '${missing}', which is not among the pending migrations. ` +
        `Either the referenced pkg is not registered or the referenced migration has already been applied.`,
    );
    this.name = "MigrationDependencyMissingError";
  }
}

/**
 * Raised by a SQLite-backed repository when its constructor cannot
 * find a `schema_meta` row for its own pkg. The migration framework
 * owns DDL post-issue-#123, so every repository's `ensureSchema()` is
 * a version-check assertion: the coordinator either populated the
 * row (success) or it didn't run (always a wiring bug). Catching the
 * `schema_meta` table itself being missing collapses into the same
 * error — the cause is identical, the operator remedy is identical.
 *
 * Uniform across every per-pkg repository that participates in the
 * coordinator framework (`session`, `task`, `catalog_agent`,
 * `catalog_skill`, `catalog_mcp`, and any future pkg). Callers can
 * `instanceof`-check once and route a single
 * "MigrationCoordinator was never run against this DB" handler
 * regardless of which repo raised it.
 *
 * `pkg` is the coordinator pkg identifier (e.g. `"task"`, `"catalog_skill"`);
 * route handlers can render it in operator-facing output. The
 * workspace pkg has its own {@link RegistryNotBootstrappedError} that
 * predates this generic type — it stays workspace-specific because it
 * also carries the `global.db` file path for the error message; both
 * concepts express the same root cause.
 */
export class SchemaMetaNotBootstrappedError extends MigrationError {
  constructor(public readonly pkg: string) {
    super(
      `pkg '${pkg}' has no schema_meta entry. ` +
        `MigrationCoordinator must run before the repository is constructed.`,
    );
    this.name = "SchemaMetaNotBootstrappedError";
  }
}

/**
 * Raised by a SQLite-backed repository when the on-disk `schema_meta`
 * row for its pkg declares a version this build does not understand.
 * Distinct from {@link SchemaMetaNotBootstrappedError} so callers can
 * separate "coordinator wasn't wired" (always a server bug) from
 * "DB belongs to a different build" (operator must upgrade /
 * downgrade).
 *
 * Same uniformity contract as {@link SchemaMetaNotBootstrappedError}:
 * every per-pkg repository raises this when its row's version doesn't
 * match the code's expected version. `dbVersion` and `codeVersion`
 * carry the comparison; the workspace pkg's
 * {@link RegistrySchemaMismatchError} is the historical workspace-
 * specific variant.
 */
export class SchemaMetaMismatchError extends MigrationError {
  constructor(
    public readonly pkg: string,
    public readonly dbVersion: number,
    public readonly codeVersion: number,
  ) {
    super(
      `pkg '${pkg}' schema mismatch: db has v${dbVersion}, ` +
        `this build expects v${codeVersion}. ` +
        (dbVersion > codeVersion
          ? "Upgrade the server (downgrading is unsafe)."
          : "Migration from the older version has not been registered."),
    );
    this.name = "SchemaMetaMismatchError";
  }
}
