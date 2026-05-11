/** Filename of the per-workspace metadata file. */
export const WORKSPACE_FILE = "workspace.json";

/**
 * Schema version for both `workspace.json` (per-workspace metadata) and
 * `workspaces.json` (the home-level index `FsWorkspaceRepository`
 * maintains).
 *
 * ## Bump policy
 *
 * Bump this number when an on-disk field is **added required**, **removed**,
 * **renamed**, or its **type / accepted values** change in a way an older
 * server cannot ignore. Purely additive changes (a new optional field with
 * a sensible default) do **not** require a bump — readers that ignore
 * unknown keys handle them transparently.
 *
 * ## Mismatch behaviour
 *
 * Readers reject any file whose `schemaVersion` does not equal this
 * constant. The reject message tells the operator which direction the
 * mismatch is in:
 *
 *   - **Newer on disk** (`onDisk > current`) — data was written by a
 *     newer emploke; the operator must upgrade their server.
 *     Downgrading the server is unsafe (silent data loss).
 *   - **Older on disk** (`onDisk < current`) — data was written by an
 *     older emploke; today there is no migration code, so reads fail
 *     with a message naming the missing migration step. When migrations
 *     are introduced they slot into the parsing layer of the FS
 *     repository: detect older versions, run a sequence of one-step
 *     migrations (`v1 -> v2`, `v2 -> v3`, ...), then re-validate.
 *
 * Note: this constant is the **wire-format version**, not part of any
 * domain type. The `Workspace` interface intentionally has no
 * `schemaVersion` field — the FS repository wraps + unwraps on save /
 * load.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** Subdirectory of a workspace that holds session workdirs. */
export const SESSIONS_SUBDIR = "sessions";

/** Subdirectory of a workspace that holds the per-workspace catalog (skills, agents, mcps). */
export const CATALOG_SUBDIR = "catalog";

/** Subdirectory of a workspace that holds task records (placeholder; v1 unused). */
export const TASKS_SUBDIR = "tasks";

/** Maximum allowed length of the display name in `workspace.json`. */
export const MAX_DISPLAY_NAME_LENGTH = 64;
