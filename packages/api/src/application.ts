import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RuntimeRegistry } from "@emploke/runtime";
import { spawnTerminal } from "@emploke/terminal";
import {
  composeWorkspaceModule,
  type Workspace,
  type WorkspaceModuleOptions,
  type WorkspaceService,
} from "@emploke/workspace";
import type { Logger } from "pino";
import {
  type SpawnFn,
  type WorkspaceContext,
  WorkspaceContextRegistry,
} from "./workspace-context.js";

export type { SpawnFn, SpawnSessionResult } from "./workspace-context.js";

/**
 * Composition root for the global registry plus on-demand
 * per-workspace contexts. The server (and future CLI / MCP / SDK
 * consumers) call `composeApplication({...})` once and route every
 * per-workspace request through the returned `Application`.
 *
 * Beyond per-workspace context resolution, this surface exposes the
 * canonical cross-BC orchestration methods (`registerWorkspace`,
 * `renameWorkspace`, `unregisterWorkspace`, `reloadWorkspace`) so
 * transport layers (HTTP routes, CLI commands) become thin adapters.
 *
 * The per-workspace `WorkspaceContextRegistry` is a private
 * implementation detail — consumers reach contexts via
 * {@link Application.getContext} / {@link Application.loadedContexts}
 * and never touch the registry class directly.
 */
export interface Application {
  readonly workspaceService: WorkspaceService;

  /**
   * Register a workspace. When `workspaceDir` is omitted the application
   * mints a fresh UUID and uses `<defaultWorkspaceParent>/<uuid>` so the
   * registry id and the directory basename stay coupled.
   *
   * Returns the canonical {@link Workspace} after register completes
   * (so callers don't have to issue a follow-up read for the
   * server-generated `createdAt`).
   */
  registerWorkspace(opts: {
    readonly name: string;
    readonly workspaceDir?: string;
  }): Promise<Workspace>;

  /**
   * Rename a workspace. Invalidates the per-workspace context so the
   * next request rebuilds with the fresh metadata. Returns the
   * canonical post-rename {@link Workspace}, or `null` if the id
   * is no longer registered (rare; concurrent unregister).
   */
  renameWorkspace(id: string, opts: { readonly newName: string }): Promise<Workspace | null>;

  /**
   * Unregister a workspace. Idempotent (no error if the id is unknown).
   * Invalidates the per-workspace context afterwards.
   */
  unregisterWorkspace(id: string, opts?: { readonly purge?: boolean }): Promise<void>;

  /**
   * Force-rebuild the cached per-workspace container. Throws
   * {@link import("./workspace-context.js").WorkspaceHasLiveTasksError}
   * when reload would orphan live task subprocesses; returns `null`
   * when the workspace id is no longer registered.
   */
  reloadWorkspace(id: string): Promise<Workspace | null>;

  /**
   * Resolve the per-workspace {@link WorkspaceContext}, building it on
   * first request. Returns `null` when the id is not registered.
   */
  getContext(id: string): Promise<WorkspaceContext | null>;

  /**
   * Snapshot of every {@link WorkspaceContext} currently held in the
   * internal registry. Used during graceful shutdown to drain live
   * task subprocesses before tearing down the SQLite handles.
   */
  loadedContexts(): WorkspaceContext[];

  /** Closes the global registry connection and every per-workspace context. Idempotent. */
  close(): Promise<void>;
}

export interface ApplicationOptions {
  readonly workspace: WorkspaceModuleOptions;
  readonly runtimeRegistry: RuntimeRegistry;
  /**
   * Directory under which `registerWorkspace({ workspaceDir: undefined })`
   * mints `<defaultWorkspaceParent>/<uuid>/`. Required because the
   * default-dir policy is part of the registration contract; without a
   * parent dir the caller MUST supply an explicit `workspaceDir`.
   */
  readonly defaultWorkspaceParent: string;
  /** Test seam for the terminal spawner; defaults to `@emploke/terminal`'s `spawnTerminal`. */
  readonly spawnFn?: SpawnFn;
  readonly logger?: Logger;
}

export async function composeApplication(opts: ApplicationOptions): Promise<Application> {
  if (!path.isAbsolute(opts.defaultWorkspaceParent)) {
    throw new Error(
      `composeApplication: defaultWorkspaceParent must be an absolute path; got ${JSON.stringify(opts.defaultWorkspaceParent)}`,
    );
  }
  const workspaceModule = await composeWorkspaceModule(opts.workspace);
  const registry = new WorkspaceContextRegistry({
    workspaceService: workspaceModule.service,
    runtimeRegistry: opts.runtimeRegistry,
    spawnFn: opts.spawnFn ?? spawnTerminal,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const workspaceService = workspaceModule.service;
  const defaultWorkspaceParent = opts.defaultWorkspaceParent;

  return {
    workspaceService,

    async registerWorkspace({ name, workspaceDir }) {
      const id = randomUUID();
      const dir =
        workspaceDir === undefined || workspaceDir.trim() === ""
          ? path.join(defaultWorkspaceParent, id)
          : path.resolve(workspaceDir);
      await workspaceService.register({ id, workspaceDir: dir, name });
      const view = await workspaceService.getById(id);
      if (view === null) {
        // Should be impossible — we just inserted it. Surface as a fault.
        throw new Error(`workspace registered but not readable back: ${id}`);
      }
      return view;
    },

    async renameWorkspace(id, { newName }) {
      await workspaceService.rename(id, { newName });
      await registry.invalidate(id);
      return workspaceService.getById(id);
    },

    async unregisterWorkspace(id, opts = {}) {
      await workspaceService.unregister(id, opts);
      await registry.invalidate(id);
    },

    async reloadWorkspace(id) {
      const ctx = await registry.reload(id);
      return ctx === null ? null : ctx.workspace;
    },

    getContext(id) {
      return registry.get(id);
    },

    loadedContexts() {
      return registry.loaded();
    },

    async close() {
      // Close the per-workspace registry first so any open per-workspace
      // SQLite handles / file watchers / SDK clients release before we
      // tear down the global registry. Documented as a caller
      // requirement on Application.close, but enforcing it here makes
      // the surface harder to misuse and matches Stripe-style
      // resource ownership (the composer composes -> the composer
      // disposes, top-down).
      await registry.closeAll();
      await workspaceModule.close();
    },
  };
}
