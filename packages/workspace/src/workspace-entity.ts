import path from "node:path";
import { CATALOG_SUBDIR, SESSIONS_SUBDIR, TASKS_SUBDIR } from "./constants.js";
import { WorkspaceCorruptedError, WorkspaceIdInvalidError } from "./errors.js";
import { assertValidDisplayName, isValidWorkspaceId } from "./names.js";

/**
 * Optional UX defaults a workspace can declare for sessions/tasks
 * dispatched inside it. Both fields are independently optional.
 */
export interface WorkspaceDefaults {
  readonly runtime?: string;
  readonly agent?: string;
}

/**
 * Rich domain entity representing a single registered workspace —
 * an emploke working unit identified by a stable UUID, sitting inside
 * a user-chosen working directory.
 *
 * Identity = `id` (immutable, the URL routing key).
 *
 * `workdir` is the only filesystem field; everything else is pure
 * metadata. Conventional sub-paths under `workdir` (`sessions/`,
 * `tasks/`, `catalog/`, the per-workspace `workspace.db` file) are
 * computed by {@link workspaceLayout} on demand — they are NOT
 * stored on the entity, so SQLite-backed callers can mint
 * `Workspace` instances without touching the layout helper.
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
    private readonly _workdir: string,
    private readonly _name: string,
    private readonly _createdAt: string,
    private readonly _defaults: WorkspaceDefaults | undefined,
  ) {}

  /**
   * Build a fresh `Workspace`. Validates the display name + id format
   * and resolves `workdir` to an absolute path. Throws typed errors:
   *
   *   - {@link WorkspaceIdInvalidError} if `id` is not a UUID
   *   - {@link import("./errors.js").WorkspaceNameInvalidError} if `name` fails {@link assertValidDisplayName}
   */
  static create(args: {
    id: string;
    name: string;
    workdir: string;
    createdAt?: string;
    defaults?: WorkspaceDefaults;
  }): Workspace {
    if (!isValidWorkspaceId(args.id)) {
      throw new WorkspaceIdInvalidError(args.id);
    }
    assertValidDisplayName(args.name);
    return new Workspace(
      args.id,
      path.resolve(args.workdir),
      args.name,
      args.createdAt ?? new Date().toISOString(),
      normaliseDefaults(args.defaults),
    );
  }

  /**
   * Reconstruct a `Workspace` from storage (e.g. a SQLite row). Same
   * validation as {@link Workspace.create}, but failures throw
   * {@link WorkspaceCorruptedError} carrying the workdir for operator
   * triage instead of the input-validation errors. Use `dir` to
   * scope the error message — typically the row's `workdir` value.
   */
  static fromStored(args: {
    dir: string;
    id: string;
    workdir: string;
    name: string;
    createdAt: string;
    defaults?: WorkspaceDefaults;
  }): Workspace {
    if (!isValidWorkspaceId(args.id)) {
      throw new WorkspaceCorruptedError(args.dir, `invalid 'id' (must be a UUID): ${args.id}`);
    }
    if (typeof args.name !== "string" || args.name.length === 0) {
      throw new WorkspaceCorruptedError(args.dir, "missing or non-string 'name'");
    }
    try {
      assertValidDisplayName(args.name);
    } catch (err) {
      throw new WorkspaceCorruptedError(args.dir, `invalid 'name': ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (typeof args.createdAt !== "string" || args.createdAt.length === 0) {
      throw new WorkspaceCorruptedError(args.dir, "missing or invalid 'createdAt'");
    }
    return new Workspace(
      args.id,
      path.resolve(args.workdir),
      args.name,
      args.createdAt,
      normaliseDefaults(args.defaults),
    );
  }

  // ── identity & metadata ─────────────────────────────────

  /** Stable UUID assigned at creation. URL routing key. */
  get id(): string {
    return this._id;
  }

  /** Absolute filesystem path the agents work under. */
  get workdir(): string {
    return this._workdir;
  }

  /** Display name (free-form text, 1-64 trimmed chars, no control chars). */
  get name(): string {
    return this._name;
  }

  /** ISO 8601 UTC timestamp at creation. */
  get createdAt(): string {
    return this._createdAt;
  }

  /** Optional UX defaults for sessions/tasks dispatched in this workspace. */
  get defaults(): WorkspaceDefaults | undefined {
    return this._defaults;
  }

  // ── transitions ────────────────────────────────────────

  /**
   * Return a new entity with one or more metadata fields replaced.
   * Identity (`id`, `workdir`, `createdAt`) is preserved — those are
   * not editable through this method.
   */
  withMetadata(patch: { name?: string; defaults?: WorkspaceDefaults | null }): Workspace {
    if (patch.name !== undefined) {
      assertValidDisplayName(patch.name);
    }
    let nextDefaults: WorkspaceDefaults | undefined = this._defaults;
    if (patch.defaults === null) {
      nextDefaults = undefined;
    } else if (patch.defaults !== undefined) {
      nextDefaults = normaliseDefaults(patch.defaults);
    }
    return new Workspace(
      this._id,
      this._workdir,
      patch.name ?? this._name,
      this._createdAt,
      nextDefaults,
    );
  }

  /** JSON shape for HTTP responses. Stable wire format. */
  toJSON(): Record<string, unknown> {
    return {
      id: this._id,
      workdir: this._workdir,
      name: this._name,
      createdAt: this._createdAt,
      ...(this._defaults ? { defaults: { ...this._defaults } } : {}),
    };
  }
}

/**
 * Conventional sub-path layout under a workspace's `workdir`. Pure
 * function; no fs side effects. Used by `WorkspaceManager` + the
 * downstream package managers (`TaskManager`, `SessionManager`,
 * `CatalogManager`) to compute the directories agents and runtimes
 * use.
 *
 * Keeping this as a standalone helper rather than baking the paths
 * into `Workspace` itself preserves the "domain entity stays clean"
 * invariant: the entity has no fs-knowledge fields beyond `workdir`.
 */
export interface WorkspaceLayout {
  readonly sessions: string;
  readonly tasks: string;
  readonly catalog: string;
}

/** Compute every fixed-name subdirectory under `workdir`. */
export function workspaceLayout(workdir: string): WorkspaceLayout {
  const root = path.resolve(workdir);
  return {
    sessions: path.join(root, SESSIONS_SUBDIR),
    tasks: path.join(root, TASKS_SUBDIR),
    catalog: path.join(root, CATALOG_SUBDIR),
  };
}

function normaliseDefaults(d: WorkspaceDefaults | undefined): WorkspaceDefaults | undefined {
  if (!d) return undefined;
  const out: WorkspaceDefaults = {
    ...(typeof d.runtime === "string" ? { runtime: d.runtime } : {}),
    ...(typeof d.agent === "string" ? { agent: d.agent } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}
