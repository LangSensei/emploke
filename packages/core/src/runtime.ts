import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type CatalogService, composeCatalogModule } from "@emploke/catalog";
import type { LaunchCommand, RuntimeRegistry } from "@emploke/runtime";
import { composeSessionModule, type SessionService } from "@emploke/session";
import { composeTaskModule, type TaskService } from "@emploke/task";
import {
  type Launcher,
  NoTerminalFoundError,
  type SpawnTerminalResult,
  spawnTerminal,
  TerminalSpawnFailedError,
  UnsupportedPlatformError,
} from "@emploke/terminal";
import {
  composeWorkspaceModule,
  type Workspace,
  type WorkspaceModuleOptions,
  type WorkspaceService,
} from "@emploke/workspace";
import pino, { type Logger } from "pino";

const silentLogger: Logger = pino({ level: "silent" });

/**
 * Inject a fake terminal spawner. Tests pass a stub to avoid touching
 * the real host; production callers omit it to get the default
 * {@link spawnTerminal} from `@emploke/terminal`.
 */
export type SpawnFn = (cmd: LaunchCommand) => Promise<SpawnTerminalResult>;

/**
 * Result of {@link WorkspaceRuntime.spawnSession}. The `display` field
 * is always present so the dashboard can show a copy-paste fallback
 * even when the terminal launch itself failed.
 */
export type SpawnSessionResult =
  | { readonly ok: true; readonly launcher: Launcher; readonly display: string }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code: string;
      readonly display: string;
    };

/**
 * Thrown by `WorkspaceRuntimeCache.reload` when the cached runtime
 * still has live task subprocesses being supervised by its
 * `TaskService`. Reload would orphan them.
 */
export class WorkspaceHasLiveTasksError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly liveCount: number,
  ) {
    super(`workspace has ${liveCount} live task(s); reload would orphan them`);
    this.name = "WorkspaceHasLiveTasksError";
  }
}

/**
 * Per-workspace bundle of long-lived state. Holds three SQLite-backed
 * services (one per BC, sharing one `workspace.db` via WAL) plus the
 * cross-BC orchestration methods for this workspace.
 */
export interface WorkspaceRuntime {
  readonly workspace: Workspace;
  readonly catalog: CatalogService;
  readonly sessions: SessionService;
  readonly tasks: TaskService;
  /**
   * Build the session's interactive launch command via
   * {@link SessionService.buildInteractiveLaunch} and immediately hand
   * it to {@link spawnTerminal} (or the injected `spawnFn`). The
   * returned `display` field is always populated so callers can show a
   * copy-paste command even on spawn failure.
   */
  spawnSession(sid: string, opts?: { remote?: boolean }): Promise<SpawnSessionResult>;
  /** Closes all backing connections. Idempotent. */
  close(): Promise<void>;
}

/**
 * Composition root for the global registry plus on-demand
 * per-workspace runtimes. The server (and future CLI / MCP / SDK
 * consumers) call `composeEmplokeCore({...})` once and route every
 * per-workspace request through the returned cache.
 *
 * Beyond the cache, this surface exposes the canonical cross-BC
 * orchestration methods (`registerWorkspace`, `renameWorkspace`,
 * `unregisterWorkspace`, `reloadWorkspace`) so transport layers
 * (HTTP routes, CLI commands) become thin adapters.
 */
export interface EmplokeCore {
  readonly workspaceService: WorkspaceService;
  readonly runtimes: WorkspaceRuntimeCache;

  /**
   * Register a workspace. When `workspaceDir` is omitted the core mints
   * a fresh UUID and uses `<defaultWorkspaceParent>/<uuid>` so the
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
   * Rename a workspace. Invalidates the per-workspace cache so the
   * next request rebuilds with the fresh metadata. Returns the
   * canonical post-rename {@link Workspace}, or `null` if the id
   * is no longer registered (rare; concurrent unregister).
   */
  renameWorkspace(id: string, opts: { readonly newName: string }): Promise<Workspace | null>;

  /**
   * Unregister a workspace. Idempotent (no error if the id is unknown).
   * Invalidates the per-workspace cache afterwards.
   */
  unregisterWorkspace(id: string, opts?: { readonly purge?: boolean }): Promise<void>;

  /**
   * Force-rebuild the cached per-workspace container. Throws
   * {@link WorkspaceHasLiveTasksError} when reload would orphan live
   * task subprocesses; returns `null` when the workspace id is no
   * longer registered.
   */
  reloadWorkspace(id: string): Promise<Workspace | null>;

  /** Closes the global registry connection. Also disposes the cache. Idempotent. */
  close(): Promise<void>;
}

export interface EmplokeCoreOptions {
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

export async function composeEmplokeCore(opts: EmplokeCoreOptions): Promise<EmplokeCore> {
  if (!path.isAbsolute(opts.defaultWorkspaceParent)) {
    throw new Error(
      `composeEmplokeCore: defaultWorkspaceParent must be an absolute path; got ${JSON.stringify(opts.defaultWorkspaceParent)}`,
    );
  }
  const workspaceModule = await composeWorkspaceModule(opts.workspace);
  const cache = new WorkspaceRuntimeCache({
    workspaceService: workspaceModule.service,
    runtimeRegistry: opts.runtimeRegistry,
    spawnFn: opts.spawnFn ?? spawnTerminal,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const workspaceService = workspaceModule.service;
  const defaultWorkspaceParent = opts.defaultWorkspaceParent;

  return {
    workspaceService,
    runtimes: cache,

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
      await cache.invalidate(id);
      return workspaceService.getById(id);
    },

    async unregisterWorkspace(id, opts = {}) {
      await workspaceService.unregister(id, opts);
      await cache.invalidate(id);
    },

    async reloadWorkspace(id) {
      const rt = await cache.reload(id);
      return rt === null ? null : rt.workspace;
    },

    async close() {
      // Close the per-workspace cache first so any open per-workspace
      // SQLite handles / file watchers / SDK clients release before we
      // tear down the global registry. Documented as a caller
      // requirement on EmplokeCore.close, but enforcing it here makes
      // the surface harder to misuse and matches Stripe-style
      // resource ownership (the composer composes -> the composer
      // disposes, top-down).
      await cache.closeAll();
      await workspaceModule.close();
    },
  };
}

/**
 * Lazy, memoised resolver from URL workspace id (UUID) to a
 * `WorkspaceRuntime`. Builds per-workspace SQLite handles + services on
 * first touch, caches them for subsequent requests.
 */
export class WorkspaceRuntimeCache {
  private readonly workspaceService: WorkspaceService;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly spawnFn: SpawnFn;
  private readonly logger: Logger;
  private readonly entries = new Map<string, WorkspaceRuntime>();
  private readonly inflight = new Map<string, Promise<WorkspaceRuntime | null>>();

  constructor(deps: {
    workspaceService: WorkspaceService;
    runtimeRegistry: RuntimeRegistry;
    spawnFn: SpawnFn;
    logger?: Logger;
  }) {
    this.workspaceService = deps.workspaceService;
    this.runtimeRegistry = deps.runtimeRegistry;
    this.spawnFn = deps.spawnFn;
    this.logger = deps.logger ?? silentLogger;
  }

  async get(id: string): Promise<WorkspaceRuntime | null> {
    const cached = this.entries.get(id);
    if (cached) return cached;
    const inflight = this.inflight.get(id);
    if (inflight) return inflight;
    const promise = this.load(id).finally(() => {
      this.inflight.delete(id);
    });
    this.inflight.set(id, promise);
    return promise;
  }

  async invalidate(id: string): Promise<void> {
    // Drain any in-flight load FIRST. Same race as reload() — without
    // this drain, a concurrent `get(id)` whose `load()` resolves after
    // we run `entries.delete(id)` will store the stale runtime AFTER
    // the invalidate completed, leaking the freshly-built runtime
    // past the caller's "I just unregistered this" expectation.
    const inflight = this.inflight.get(id);
    if (inflight) {
      try {
        await inflight;
      } catch {
        // best-effort — the load that produced the throw is the
        // caller's problem, not ours.
      }
    }
    const cached = this.entries.get(id);
    if (cached) {
      try {
        await cached.close();
      } catch {
        // best-effort
      }
      this.logger.info({ workspaceId: id }, "per-workspace container invalidated");
    }
    this.entries.delete(id);
  }

  async reload(id: string): Promise<WorkspaceRuntime | null> {
    // First, drain any in-flight `get()` for this id. Without this,
    // a concurrent caller of get() could finish loading AFTER our
    // `entries.delete(id)` line and re-populate the cache with a
    // stale entry that immediately leaks (our subsequent get() would
    // mint a different one).
    const inflight = this.inflight.get(id);
    if (inflight) {
      try {
        await inflight;
      } catch {
        // best-effort — propagate via the eventual get() below
      }
    }
    const cached = this.entries.get(id);
    if (cached) {
      const live = cached.tasks.liveCount();
      if (live > 0) {
        this.logger.warn(
          { workspaceId: id, liveCount: live },
          "workspace reload refused: live tasks would be orphaned",
        );
        throw new WorkspaceHasLiveTasksError(id, live);
      }
      try {
        await cached.close();
      } catch {
        // best-effort
      }
    }
    this.entries.delete(id);
    const fresh = await this.get(id);
    if (fresh !== null) {
      this.logger.info({ workspaceId: id }, "per-workspace container reloaded");
    }
    return fresh;
  }

  loaded(): WorkspaceRuntime[] {
    return [...this.entries.values()];
  }

  async closeAll(): Promise<void> {
    // Drain in-flight loads first. Without this, a concurrent
    // `get(id)` whose promise resolves AFTER our iteration over
    // `entries` would re-populate the map post-close and leak the
    // newly-built runtime past process exit. Same drain-then-act
    // pattern used by `reload(id)`.
    const inflight = [...this.inflight.values()];
    for (const p of inflight) {
      try {
        await p;
      } catch {
        // best-effort
      }
    }
    for (const rt of this.entries.values()) {
      try {
        await rt.close();
      } catch {
        // best-effort
      }
    }
    this.entries.clear();
  }

  private async load(id: string): Promise<WorkspaceRuntime | null> {
    const workspace = await this.workspaceService.getById(id);
    if (!workspace) return null;

    const dbFile = path.join(workspace.workspaceDir, "workspace.db");
    await mkdir(workspace.workspaceDir, { recursive: true });

    // Partial-failure safety: each successive composeXxxModule opens
    // its own SQLite handle. If a later one throws, the earlier
    // handles would leak (file lock held, WAL file pinned, …) unless
    // we tear them down on the failure path. Track each handle as we
    // build, and on any throw run them in reverse order so the
    // entire load is "all-or-nothing" from a resource POV.
    const cleanup: Array<() => Promise<void>> = [];
    const teardown = async (): Promise<void> => {
      while (cleanup.length > 0) {
        const fn = cleanup.pop();
        if (!fn) break;
        try {
          await fn();
        } catch {
          // best-effort — primary error has already been thrown
        }
      }
    };

    let catalogModule: Awaited<ReturnType<typeof composeCatalogModule>>;
    let sessionModule: Awaited<ReturnType<typeof composeSessionModule>>;
    let taskModule: Awaited<ReturnType<typeof composeTaskModule>>;
    try {
      catalogModule = await composeCatalogModule({
        dbFile,
        logger: this.logger,
      });
      cleanup.push(() => catalogModule.close());
      sessionModule = await composeSessionModule({
        dbFile,
        catalog: catalogModule.service,
        runtimeRegistry: this.runtimeRegistry,
        workspaceDir: workspace.workspaceDir,
        workspaceId: id,
        logger: this.logger,
      });
      cleanup.push(() => sessionModule.close());
      taskModule = await composeTaskModule({
        dbFile,
        catalog: catalogModule.service,
        runtimeRegistry: this.runtimeRegistry,
        workspaceDir: workspace.workspaceDir,
        workspaceId: id,
        logger: this.logger,
      });
      cleanup.push(() => taskModule.close());

      await taskModule.service.recoverOrphaned();
    } catch (err) {
      await teardown();
      throw err;
    }

    const sessions = sessionModule.service;
    const spawnFn = this.spawnFn;
    const outerLogger = this.logger;
    const runtime: WorkspaceRuntime = {
      workspace,
      catalog: catalogModule.service,
      sessions,
      tasks: taskModule.service,
      async spawnSession(sid, opts) {
        // buildInteractiveLaunch can throw (e.g.
        // RuntimeDoesNotSupportRemoteError, TrustRegistrationFailed,
        // ENOENT on a stale runtimeSessionId). The SpawnSessionResult
        // contract documents that `display` is ALWAYS present so the
        // dashboard can show a copy-paste fallback even on failure —
        // wrapping only the spawn step would let a build-side throw
        // skip past the result-shape entirely.
        let cmd: LaunchCommand;
        try {
          cmd = await sessions.buildInteractiveLaunch(sid, {
            ...(opts?.remote === true ? { remote: true } : {}),
          });
        } catch (err) {
          return {
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
            code: err instanceof Error && err.name ? err.name : "BuildLaunchError",
            display: "",
          };
        }
        try {
          const result = await spawnFn(cmd);
          return {
            ok: true as const,
            launcher: result.launcher,
            display: cmd.display,
          };
        } catch (err) {
          return {
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
            code: spawnErrorCode(err),
            display: cmd.display,
          };
        }
      },
      async close() {
        // Per-module try/catch: a throw from one module's close()
        // must NOT skip the other two. Earlier shape chained awaits
        // bare, so a `taskModule.close()` throw leaked the session +
        // catalog SQLite handles. Same all-or-nothing disposal idiom
        // as load()'s cleanup stack.
        //
        // Multi-error handling: the FIRST error is re-thrown so the
        // caller sees something; LATER errors are logged via the
        // pkg's `silentLogger`-or-injected logger so a wedged 2nd
        // module isn't lost. Previously this loop iterated but
        // discarded later errors via `void e`, contradicting the
        // comment that promised operator logging.
        const errors: unknown[] = [];
        try {
          await taskModule.close();
        } catch (err) {
          errors.push(err);
        }
        try {
          await sessionModule.close();
        } catch (err) {
          errors.push(err);
        }
        try {
          await catalogModule.close();
        } catch (err) {
          errors.push(err);
        }
        if (errors.length > 0) {
          for (const e of errors.slice(1)) {
            outerLogger.error(
              { workspaceId: id, err: e instanceof Error ? e.message : String(e) },
              "per-workspace container close: secondary module failed during disposal",
            );
          }
          throw errors[0];
        }
      },
    };
    this.entries.set(id, runtime);
    this.logger.info(
      { workspaceId: id, workspaceDir: workspace.workspaceDir, dbPath: dbFile },
      "per-workspace container built (first request)",
    );
    return runtime;
  }
}

function spawnErrorCode(err: unknown): string {
  if (err instanceof NoTerminalFoundError) return "NoTerminalFoundError";
  if (err instanceof TerminalSpawnFailedError) return "TerminalSpawnFailedError";
  if (err instanceof UnsupportedPlatformError) return "UnsupportedPlatformError";
  if (err instanceof Error && err.name) return err.name;
  return "SpawnError";
}
