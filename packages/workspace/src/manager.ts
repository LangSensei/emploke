import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  WorkspaceAlreadyExistsError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNotFoundError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "./errors.js";
import { assertValidDisplayName, isValidWorkspaceId } from "./names.js";
import type { WorkspaceRepository } from "./repositories/repository.js";
import { type Workspace, workspaceLayout } from "./types.js";

/** Options accepted by `WorkspaceManager.init`. */
export interface WorkspaceInitOpts {
  /** Display name for the new workspace. Required. 1–64 trimmed chars, no control chars. */
  readonly name: string;
  /** Absolute path the user picked for the workspace. emploke will mkdir this if it does not exist. */
  readonly workdir: string;
  /** Optional UX defaults baked into the workspace metadata. */
  readonly defaults?: Workspace["defaults"];
  /**
   * Pin the workspace id (tests / migrations only). Production callers
   * always omit this to let the manager mint a fresh UUID.
   */
  readonly id?: string;
  /** Test seam for `createdAt`. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** Mutable fields accepted by `WorkspaceManager.update`. */
export interface WorkspaceUpdatePatch {
  /** New display name. Skipped when `undefined`. */
  readonly name?: string;
  /**
   * New defaults block. Pass `null` to clear; pass an object to overwrite
   * the existing block in full. Skipped when `undefined`.
   */
  readonly defaults?: Workspace["defaults"] | null;
}

/** Options accepted by `WorkspaceManager.delete`. */
export interface WorkspaceDeleteOpts {
  /**
   * When `true`, also remove every emploke-owned subdirectory under the
   * workspace's `workdir` (`tasks/`, `sessions/`, `catalog/`,
   * `workflows/`, `logs/`). The `workdir` itself is **never** removed —
   * it is user-owned and may contain files emploke does not know about.
   *
   * Default `false`: only the workspace metadata is removed; agent
   * artifacts, catalog definitions, etc. survive deletion. The
   * dashboard surfaces the choice as an explicit checkbox.
   */
  readonly purge?: boolean;
}

/**
 * Workspace lifecycle façade. All persistence flows through the
 * supplied `WorkspaceRepository` (defaults to `FsWorkspaceRepository`
 * when constructed via the static factory below). The manager owns
 * filesystem side-effects that are NOT persistence — creating the
 * workspace directory and standard subdirs at init time, and the
 * optional `purge`-mode cleanup at delete time.
 *
 * Concurrency: cross-process serialisation lives in the repository
 * (see `FsWorkspaceRepository`'s advisory lock). The manager itself is
 * stateless beyond the injected repository reference, so two
 * `WorkspaceManager` instances pointing at the same repository are
 * safe to use concurrently.
 */
export class WorkspaceManager {
  constructor(private readonly repository: WorkspaceRepository) {}

  /** All registered workspaces. */
  list(): Promise<Workspace[]> {
    return this.repository.list();
  }

  /** Look up a registered workspace by id; `null` when unregistered. */
  read(id: string): Promise<Workspace | null> {
    return this.repository.read(id);
  }

  /**
   * Register a new workspace. Creates the `workdir` (and standard
   * subdirs) on disk if they do not already exist, then persists the
   * workspace metadata + index entry. Throws when the workspace is
   * already registered (use `update` for renames / defaults changes).
   */
  async init(opts: WorkspaceInitOpts): Promise<Workspace> {
    assertValidDisplayName(opts.name);
    if (opts.id !== undefined && !isValidWorkspaceId(opts.id)) {
      throw new WorkspaceIdInvalidError(opts.id);
    }

    const id = opts.id ?? randomUUID();
    const resolvedWorkdir = path.resolve(opts.workdir);

    // Refuse to silently shadow an existing registration. Callers who
    // want idempotent semantics should call `read` first and skip
    // `init` if the id already exists.
    const existingById = await this.repository.read(id);
    if (existingById) throw new WorkspaceIdConflictError(id);
    const sameDir = (await this.repository.list()).find((e) => e.workdir === resolvedWorkdir);
    if (sameDir) throw new WorkspacePathConflictError(resolvedWorkdir, sameDir.id);

    // Create the workspace directory + standard subdirs. The user
    // pre-existing files inside `workdir` are preserved; we only touch
    // the named subdirs.
    await mkdir(resolvedWorkdir, { recursive: true });
    const layout = workspaceLayout(resolvedWorkdir);
    await Promise.all([
      mkdir(layout.sessions, { recursive: true }),
      mkdir(layout.tasks, { recursive: true }),
      mkdir(layout.catalog, { recursive: true }),
      mkdir(layout.workflows, { recursive: true }),
      mkdir(layout.logs, { recursive: true }),
    ]);

    const now = opts.now ?? (() => new Date());
    const workspace: Workspace = {
      id,
      name: opts.name,
      createdAt: now().toISOString(),
      workdir: resolvedWorkdir,
      ...(opts.defaults ? { defaults: opts.defaults } : {}),
    };
    await this.repository.save(workspace);
    return workspace;
  }

  /**
   * Update mutable fields (`name`, `defaults`) on a registered
   * workspace. Throws `WorkspaceNotRegisteredError` when no workspace
   * with the given id exists. Cannot be used to change `id` or
   * `workdir` — those are immutable for the lifetime of the workspace.
   */
  async update(id: string, patch: WorkspaceUpdatePatch): Promise<Workspace> {
    const current = await this.repository.read(id);
    if (!current) throw new WorkspaceNotRegisteredError(id);
    if (patch.name !== undefined) assertValidDisplayName(patch.name);

    const nextName = patch.name ?? current.name;
    const nextDefaults =
      patch.defaults === undefined ? current.defaults : (patch.defaults ?? undefined);

    const updated: Workspace = {
      id: current.id,
      workdir: current.workdir,
      createdAt: current.createdAt,
      name: nextName,
      ...(nextDefaults ? { defaults: nextDefaults } : {}),
    };
    await this.repository.save(updated);
    return updated;
  }

  /**
   * Remove a registered workspace. Default behaviour removes only the
   * emploke metadata (the registry entry + `workspace.json`). Pass
   * `{ purge: true }` to additionally rm every emploke-owned
   * subdirectory under the workspace's `workdir`; the `workdir` itself
   * is preserved either way (user-owned). Idempotent for unregistered ids.
   */
  async delete(id: string, opts: WorkspaceDeleteOpts = {}): Promise<void> {
    let purgeWorkdir: string | null = null;
    if (opts.purge) {
      const current = await this.repository.read(id);
      if (current) purgeWorkdir = current.workdir;
    }
    await this.repository.delete(id);
    if (purgeWorkdir) {
      const layout = workspaceLayout(purgeWorkdir);
      await Promise.all([
        rm(layout.sessions, { recursive: true, force: true }),
        rm(layout.tasks, { recursive: true, force: true }),
        rm(layout.catalog, { recursive: true, force: true }),
        rm(layout.workflows, { recursive: true, force: true }),
        rm(layout.logs, { recursive: true, force: true }),
      ]);
    }
  }

  /** Id of the most-recently-selected workspace (or `null`). */
  getCurrent(): Promise<string | null> {
    return this.repository.getCurrent();
  }

  /** Mark `id` as current. Throws if `id` is not registered. */
  setCurrent(id: string): Promise<void> {
    return this.repository.setCurrent(id);
  }
}

// Suppress unused-warning in environments where the typed errors are
// only thrown reflectively via repository implementations.
void WorkspaceAlreadyExistsError;
void WorkspaceNotFoundError;
