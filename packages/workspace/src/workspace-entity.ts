import path from "node:path";
import { SESSIONS_SUBDIR, TASKS_SUBDIR } from "./constants.js";
import { WorkspaceCorruptedError, WorkspaceIdInvalidError } from "./errors.js";
import { assertValidDisplayName, isValidWorkspaceId } from "./names.js";

/**
 * Rich domain entity representing a single registered workspace —
 * an emploke working unit identified by a stable UUID, sitting inside
 * a user-chosen working directory.
 *
 * Identity = `id` (immutable, the URL routing key).
 *
 * `workspaceDir` is the only filesystem field; everything else is pure
 * metadata. Conventional sub-paths under `workspaceDir` (`sessions/`,
 * `tasks/`, plus the per-workspace `workspace.db` file) are computed
 * by {@link workspaceLayout} on demand — they are NOT stored on the
 * entity, so SQLite-backed callers can mint `Workspace` instances
 * without touching the layout helper. There is no `catalog/` subdir;
 * catalog content lives inside `workspace.db` as BLOB rows.
 *
 * ## Naming convention (locked alongside issue #121)
 *
 * `workspaceDir` (entity field, TS) / `workspace_dir` (SQL column) is
 * the workspace's root directory. The shorter `workdir` is reserved
 * for derived per-entity working directories used by downstream
 * packages (`task.workdir = <workspaceDir>/tasks/<id>`,
 * `session.workdir = <workspaceDir>/sessions/<id>`). Both concepts
 * used to be called `workdir`, which created an ambiguity the v1→v2
 * migration finally resolved.
 *
 * ## Construction
 *
 * - {@link Workspace.create} — for fresh workspaces. Validates the
 *   display name and id format. Sets `createdAt` to `now()` if
 *   omitted (test-injectable via the optional clock).
 * - {@link Workspace.fromStored} — for entities reconstructed from
 *   storage. Mirrors `create` but skips defaulting and surfaces
 *   `WorkspaceCorruptedError` for storage-side shape failures
 *   (typed `dir` for the operator's eyes).
 *
 * Mirrors the DDD style used by `@emploke/catalog`'s `Agent` /
 * `Skill` / `Mcp`. Plain-`interface` style (used by `@emploke/task`,
 * `@emploke/session`) is being migrated to the same pattern; see
 * https://github.com/LangSensei/emploke/issues/84.
 */
export class Workspace {
  private constructor(
    private readonly _id: string,
    private readonly _workspaceDir: string,
    private readonly _name: string,
    private readonly _createdAt: string,
  ) {}

  /**
   * Build a fresh `Workspace`. Validates the display name + id format
   * and resolves `workspaceDir` to an absolute path. Throws typed errors:
   *
   *   - {@link WorkspaceIdInvalidError} if `id` is not a UUID
   *   - {@link import("./errors.js").WorkspaceNameInvalidError} if `name` fails {@link assertValidDisplayName}
   */
  static create(args: {
    id: string;
    name: string;
    workspaceDir: string;
    createdAt?: string;
  }): Workspace {
    if (!isValidWorkspaceId(args.id)) {
      throw new WorkspaceIdInvalidError(args.id);
    }
    assertValidDisplayName(args.name);
    return new Workspace(
      args.id,
      path.resolve(args.workspaceDir),
      args.name,
      args.createdAt ?? new Date().toISOString(),
    );
  }

  /**
   * Reconstruct a `Workspace` from storage (e.g. a SQLite row). Same
   * validation as {@link Workspace.create}, but failures throw
   * {@link WorkspaceCorruptedError} carrying the `workspaceDir` for
   * operator triage instead of the input-validation errors used by
   * {@link Workspace.create}.
   */
  static fromStored(args: {
    id: string;
    workspaceDir: string;
    name: string;
    createdAt: string;
  }): Workspace {
    if (!isValidWorkspaceId(args.id)) {
      throw new WorkspaceCorruptedError(
        args.workspaceDir,
        `invalid 'id' (must be a UUID): ${args.id}`,
      );
    }
    if (typeof args.name !== "string" || args.name.length === 0) {
      throw new WorkspaceCorruptedError(args.workspaceDir, "missing or non-string 'name'");
    }
    try {
      assertValidDisplayName(args.name);
    } catch (err) {
      throw new WorkspaceCorruptedError(
        args.workspaceDir,
        `invalid 'name': ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (typeof args.createdAt !== "string" || args.createdAt.length === 0) {
      throw new WorkspaceCorruptedError(args.workspaceDir, "missing or invalid 'createdAt'");
    }
    return new Workspace(args.id, path.resolve(args.workspaceDir), args.name, args.createdAt);
  }

  // ── identity & metadata ─────────────────────────────────

  /** Stable UUID assigned at creation. URL routing key. */
  get id(): string {
    return this._id;
  }

  /**
   * Absolute filesystem path the workspace lives under (the root the
   * agents work inside). Immutable across the workspace's lifetime.
   */
  get workspaceDir(): string {
    return this._workspaceDir;
  }

  /** Display name (free-form text, 1-64 trimmed chars, no control chars). */
  get name(): string {
    return this._name;
  }

  /** ISO 8601 UTC timestamp at creation. */
  get createdAt(): string {
    return this._createdAt;
  }

  // ── transitions ────────────────────────────────────────

  /**
   * Return a new entity with one or more metadata fields replaced.
   * Identity (`id`, `workspaceDir`, `createdAt`) is preserved — those
   * are not editable through this method.
   */
  withMetadata(patch: { name?: string }): Workspace {
    if (patch.name !== undefined) {
      assertValidDisplayName(patch.name);
    }
    return new Workspace(this._id, this._workspaceDir, patch.name ?? this._name, this._createdAt);
  }

  /** JSON shape for HTTP responses. Stable wire format. */
  toJSON(): Record<string, unknown> {
    return {
      id: this._id,
      workspaceDir: this._workspaceDir,
      name: this._name,
      createdAt: this._createdAt,
    };
  }
}

/**
 * Conventional sub-path layout under a workspace's `workspaceDir`.
 * Pure function; no fs side effects. Used by `WorkspaceManager` + the
 * downstream package managers (`TaskManager`, `SessionManager`,
 * `CatalogManager`) to compute the directories agents and runtimes
 * use.
 *
 * Keeping this as a standalone helper rather than baking the paths
 * into `Workspace` itself preserves the "domain entity stays clean"
 * invariant: the entity has no fs-knowledge fields beyond
 * `workspaceDir`.
 */
export interface WorkspaceLayout {
  readonly sessions: string;
  readonly tasks: string;
}

/** Compute every fixed-name subdirectory under `workspaceDir`. */
export function workspaceLayout(workspaceDir: string): WorkspaceLayout {
  const root = path.resolve(workspaceDir);
  return {
    sessions: path.join(root, SESSIONS_SUBDIR),
    tasks: path.join(root, TASKS_SUBDIR),
  };
}
