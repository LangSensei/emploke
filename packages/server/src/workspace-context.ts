import { CatalogManager } from "@emploke/catalog";
import { type Logger, silentLogger } from "@emploke/logger";
import type { RuntimeRegistry } from "@emploke/runtime";
import { SessionManager } from "@emploke/session";
import { TaskManager } from "@emploke/task";
import { type Workspace, type WorkspaceManager, workspaceLayout } from "@emploke/workspace";

/**
 * Thrown by `WorkspaceContextCache.reload` when the cached context for
 * the requested workspace still has live task subprocesses being
 * supervised by its `TaskManager`.
 *
 * Reload would `entries.delete(id)` and let the next request lazy-build
 * a fresh context. The fresh `TaskManager`'s `recoverOrphaned` sweep
 * would see the on-disk `task.json` rows still flipped to `running`
 * (because the OLD manager's exit watcher hasn't fired yet) and race
 * to reclassify them as `failure`, even though the subprocess itself
 * is alive and well. To keep that race off the table we refuse the
 * reload and surface this typed error to the caller (the route maps
 * it to HTTP 409).
 *
 * The user resolves it the same way as any other in-flight conflict:
 * cancel the running tasks (or wait for them to finish), then retry.
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
 * Per-workspace bundle of long-lived state. The server caches one of these
 * per registered workspace and hands it to route handlers via Hono context.
 *
 * `catalog` is constructed against `<workspace.workdir>/catalog/` so each
 * workspace has an isolated agent/skill/mcp set; `sessions` and `tasks`
 * reuse that catalog. Future managers (workflows) join this struct as
 * siblings.
 */
export interface WorkspaceContext {
  readonly workspace: Workspace;
  readonly catalog: CatalogManager;
  readonly sessions: SessionManager;
  readonly tasks: TaskManager;
}

/**
 * Lazy, memoised resolver from URL workspace id (UUID) to a
 * `WorkspaceContext`.
 *
 * Lookup flow on a cache miss:
 *   1. Look up the workspace via the injected `WorkspaceManager`. If
 *      not registered, return null — the route handler will respond 404.
 *   2. Open a per-workspace `CatalogManager` rooted at `<workspace>/catalog/`.
 *   3. Build `SessionManager` and `TaskManager` pointed at the
 *      per-workspace state directories. Both receive `workspaceDir` so
 *      runtime adapters can run any per-launch / per-dispatch
 *      preflights they need (e.g. Copilot's interactive-mode trust
 *      write into `~/.copilot/config.json`) without the server having
 *      to know which runtime needs what.
 *   4. Cache the bundle keyed by id.
 *
 * We cache by id (URL identifier) rather than by absolute path so a stale
 * cache entry can be expired with `invalidate(id)` when the workspace
 * mutates (delete, metadata rename).
 */
export class WorkspaceContextCache {
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly workspaces: WorkspaceManager;
  private readonly logger: Logger;
  private readonly entries = new Map<string, WorkspaceContext>();
  /**
   * Inflight lookups keyed by id, to dedupe concurrent first-request
   * stampedes (catalog opens and orphan-task recovery are both bounded
   * but non-trivial; we don't want N parallel runs for one workspace).
   */
  private readonly inflight = new Map<string, Promise<WorkspaceContext | null>>();

  constructor(deps: {
    runtimeRegistry: RuntimeRegistry;
    workspaces: WorkspaceManager;
    /**
     * Logger threaded down into every `SessionManager` / `TaskManager`
     * the cache lazy-instantiates. Defaults to `silentLogger` so
     * non-server callers (tests) don't need to pass one.
     */
    logger?: Logger;
  }) {
    this.runtimeRegistry = deps.runtimeRegistry;
    this.workspaces = deps.workspaces;
    this.logger = deps.logger ?? silentLogger;
  }

  /**
   * Resolve a registered workspace by id. Returns null if no workspace
   * with that id exists. Throws on workspace metadata read failures or
   * runtime setup failures (the route handler maps to 5xx).
   */
  async get(id: string): Promise<WorkspaceContext | null> {
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

  /**
   * Drop the cached context for `id`. Safe to call when no entry exists.
   * Invoked by routes that mutate workspace metadata (rename, remove)
   * so the next request sees a fresh world. Closes the catalog's
   * SQLite handles before dropping the entry.
   */
  invalidate(id: string): void {
    const cached = this.entries.get(id);
    if (cached) {
      try {
        cached.catalog.close();
      } catch {
        // best-effort
      }
      try {
        cached.sessions.close();
      } catch {
        // best-effort
      }
      try {
        cached.tasks.close();
      } catch {
        // best-effort
      }
    }
    this.entries.delete(id);
  }

  /**
   * Drop the cached context for `id` and eagerly rebuild it. Returns
   * the fresh context, or null if the workspace is no longer registered.
   *
   * Use case: workspace-level state drift the cached managers can't
   * observe themselves. Today that means orphan-task recovery: the
   * cached `TaskManager` only sweeps `task.json` rows once at first
   * touch, so reload re-runs that sweep against the on-disk truth.
   *
   * Catalog content drift no longer needs reload — `CatalogManager`
   * holds no in-memory snapshot, so a `git pull` of the workspace's
   * `catalog.db` (or any external write) is observable on the next
   * request. The cached `CatalogManager` only owns the SQLite handle
   * itself.
   *
   * Refuses (`WorkspaceHasLiveTasksError`) when the existing cached
   * context still has live task subprocesses — see the class jsdoc for
   * why eviction-during-live-task is unsafe. The caller is expected to
   * cancel / wait, then retry.
   *
   * The live-count check + `entries.delete` is a microscopic TOCTOU:
   * a dispatch landing between the two would slip through the gate.
   * In practice this is harmless because (a) `liveCount()` includes
   * `dispatchInProgress` so the window is sub-tick (the dispatch's
   * first await happens AFTER the id is in `dispatchInProgress`), and
   * (b) `recoverOrphaned`'s PID-alive probe in the freshly built
   * TaskManager would skip the still-alive row rather than flip it
   * to failure. Worth knowing for any future caller that expects
   * strict ordering.
   *
   * Note: this surface intentionally does NOT touch any user-driven
   * eviction policy (LRU / TTL / size cap). Those are tracked separately
   * (issue #30) and need product calls about kill-vs-detach semantics
   * that this slice deliberately sidesteps.
   */
  async reload(id: string): Promise<WorkspaceContext | null> {
    const cached = this.entries.get(id);
    if (cached) {
      const live = cached.tasks.liveCount();
      if (live > 0) {
        throw new WorkspaceHasLiveTasksError(id, live);
      }
      try {
        cached.catalog.close();
      } catch {
        // best-effort
      }
      try {
        cached.sessions.close();
      } catch {
        // best-effort
      }
      try {
        cached.tasks.close();
      } catch {
        // best-effort
      }
    }
    this.entries.delete(id);
    return this.get(id);
  }

  /**
   * Snapshot of every currently-loaded context. Used by the server's
   * graceful-shutdown hook to drain `TaskManager` subprocesses without
   * forcing every consumer of the cache to depend on `@emploke/task`.
   */
  loaded(): WorkspaceContext[] {
    return [...this.entries.values()];
  }

  /**
   * Close every cached context's CatalogManager, releasing SQLite
   * file handles. Required at server shutdown (so the OS releases
   * the catalog.db lock cleanly) and at the end of every test that
   * created ephemeral workspaces (Windows refuses to unlink files
   * with open handles, so the test cleanup `rm -rf <scratch>` would
   * fail with EBUSY without this).
   *
   * Drops every cache entry as a side effect — subsequent `get(id)`
   * calls rebuild from scratch.
   */
  closeAll(): void {
    for (const ctx of this.entries.values()) {
      try {
        ctx.catalog.close();
      } catch {
        // best-effort
      }
      try {
        ctx.sessions.close();
      } catch {
        // best-effort
      }
      try {
        ctx.tasks.close();
      } catch {
        // best-effort
      }
    }
    this.entries.clear();
  }

  private async load(id: string): Promise<WorkspaceContext | null> {
    const workspace = await this.workspaces.read(id);
    if (!workspace) return null;

    const layout = workspaceLayout(workspace.workdir);
    const catalog = await CatalogManager.open({
      catalogDir: layout.catalog,
      logger: this.logger,
    });

    const sessions = new SessionManager({
      catalog,
      runtimeRegistry: this.runtimeRegistry,
      sessionsDir: layout.sessions,
      workspaceDir: workspace.workdir,
      logger: this.logger,
    });

    const tasks = new TaskManager({
      catalog,
      runtimeRegistry: this.runtimeRegistry,
      tasksDir: layout.tasks,
      workspaceDir: workspace.workdir,
      logger: this.logger,
    });
    // Sweep persisted tasks marked `running` from a previous server lifetime
    // and flip them to `failure`. Cheap (one fs scan + per-orphan rewrite),
    // and it eliminates ghost-running rows in the dashboard immediately on
    // first request to this workspace.
    await tasks.recoverOrphaned();

    const ctx: WorkspaceContext = { workspace, catalog, sessions, tasks };
    this.entries.set(id, ctx);
    return ctx;
  }
}
