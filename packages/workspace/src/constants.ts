/**
 * Schema version for the workspace pkg's row in
 * `global.db.schema_meta` (`SqliteWorkspaceRepository` writes one row
 * keyed by `pkg='workspace'`).
 *
 * ## Bump policy
 *
 * Bump when a column on `workspaces` is removed, renamed, or its
 * semantics change in a way an older server cannot ignore. Purely
 * additive changes (a new column with a sensible default) do not
 * require a bump — readers that ignore unknown columns handle them
 * transparently.
 *
 * ## Mismatch behaviour
 *
 * The repository refuses to open if the on-disk row's `version` does
 * not equal this constant — it throws `RegistrySchemaMismatchError`
 * with a direction-aware message:
 *
 *   - **Newer on disk** — data was written by a newer emploke; upgrade
 *     the server. Downgrading is unsafe (silent data loss).
 *   - **Older on disk** — data was written by an older emploke; no
 *     migration code today, so the reader fails with a clear hint.
 *     When migrations are introduced they slot into the repository's
 *     `ensureSchema()`: detect older versions, run a sequence of
 *     one-step migrations (`v1 -> v2`, `v2 -> v3`, ...), then bump.
 *
 * Note: this constant is the wire-format version, not part of any
 * domain type. The `Workspace` entity intentionally has no
 * `schemaVersion` field.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** Subdirectory of a workspace that holds session workdirs. */
export const SESSIONS_SUBDIR = "sessions";

/** Subdirectory of a workspace that holds the per-workspace catalog (skills, agents, mcps). */
export const CATALOG_SUBDIR = "catalog";

/** Subdirectory of a workspace that holds task records. */
export const TASKS_SUBDIR = "tasks";

/** Maximum allowed length of the workspace display name. */
export const MAX_DISPLAY_NAME_LENGTH = 64;
