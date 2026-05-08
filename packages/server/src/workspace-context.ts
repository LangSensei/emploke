import path from "node:path";
import { Catalog } from "@emploke/catalog";
import {
  type Runtime,
  RuntimeRegisterWorkspaceFailed,
  type RuntimeRegistry,
} from "@emploke/runtime";
import { SessionManager } from "@emploke/session";
import { TaskManager } from "@emploke/task";
import { type Workspace, WorkspaceManager, type WorkspaceRegistry } from "@emploke/workspace";

/**
 * Per-workspace bundle of long-lived state. The server caches one of these
 * per registered workspace and hands it to route handlers via Hono context.
 *
 * `catalog` is constructed against `<workspace>/catalog/` so each workspace
 * has an isolated agent/skill/mcp set; `sessions` and `tasks` reuse that
 * catalog. Future managers (workflows) will join this struct as siblings.
 */
export interface WorkspaceContext {
  readonly workspace: Workspace;
  readonly catalog: Catalog;
  readonly sessions: SessionManager;
  readonly tasks: TaskManager;
}

/**
 * Lazy, memoised resolver from URL workspace id (UUID) to a
 * `WorkspaceContext`.
 *
 * Lookup flow on a cache miss:
 *   1. Validate that `id` is in the home-level `WorkspaceRegistry`. If
 *      not, return null  the route handler will respond 404.
 *   2. `WorkspaceManager.open()` the registered path. Throws on missing /
 *      corrupted `workspace.json`; the route handler converts to 5xx.
 *   3. Open a per-workspace `Catalog` rooted at `<workspace>/catalog/`.
 *      Lazy-creates the directory if missing.
 *   4. Call `Runtime.registerWorkspace?` on every registered runtime so
 *      one-time setup (e.g. trust) happens before any session actually
 *      runs in this workspace. Failures wrap as `RuntimeRegisterWorkspaceFailed`.
 *   5. Build a `SessionManager` pointed at `<workspace>/sessions/` and
 *      bound to the per-workspace catalog.
 *   6. Cache the bundle keyed by id.
 *
 * We cache by id (URL identifier) rather than by absolute path so a stale
 * cache entry can be expired with `invalidate(id)` when the registry
 * mutates (delete, metadata rename).
 */
export class WorkspaceContextCache {
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly registry: WorkspaceRegistry;
  private readonly entries = new Map<string, WorkspaceContext>();
  /**
   * Inflight lookups keyed by id, to dedupe concurrent first-request
   * stampedes (the `registerWorkspace` calls each runtime makes can be
   * expensive  we don't want N parallel calls for one workspace).
   */
  private readonly inflight = new Map<string, Promise<WorkspaceContext | null>>();

  constructor(deps: {
    runtimeRegistry: RuntimeRegistry;
    registry: WorkspaceRegistry;
  }) {
    this.runtimeRegistry = deps.runtimeRegistry;
    this.registry = deps.registry;
  }

  /**
   * Resolve a registered workspace by id. Returns null if no entry exists
   * with that id. Throws on workspace.json read failures or runtime setup
   * failures (the route handler maps to 5xx).
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
   * Invoked by routes that mutate registry/metadata state (rename, remove)
   * so the next request sees a fresh world.
   */
  invalidate(id: string): void {
    this.entries.delete(id);
  }

  /**
   * Snapshot of every currently-loaded context. Used by the server's
   * graceful-shutdown hook to drain `TaskManager` subprocesses without
   * forcing every consumer of the cache to depend on `@emploke/task`.
   */
  loaded(): WorkspaceContext[] {
    return [...this.entries.values()];
  }

  private async load(id: string): Promise<WorkspaceContext | null> {
    const entry = this.registry.get(id);
    if (!entry) return null;

    const workspace = await WorkspaceManager.open(entry.path);
    await registerWorkspaceWithRuntimes(this.runtimeRegistry, workspace.dir);

    const catalog = await Catalog.open({ catalogDir: workspace.catalogDir });

    const sessions = new SessionManager({
      catalog,
      runtimeRegistry: this.runtimeRegistry,
      sessionsDir: workspace.sessionsDir,
    });

    const tasks = new TaskManager({
      catalog,
      runtimeRegistry: this.runtimeRegistry,
      tasksDir: workspace.tasksDir,
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

/**
 * Call `registerWorkspace` on every runtime that implements it. Runtimes
 * without the optional method are skipped silently. Failures wrap into
 * `RuntimeRegisterWorkspaceFailed` so callers see a typed error.
 *
 * Exported for tests.
 */
export async function registerWorkspaceWithRuntimes(
  registry: RuntimeRegistry,
  workspaceDir: string,
): Promise<void> {
  const dir = path.resolve(workspaceDir);
  const tasks: Promise<void>[] = [];
  for (const kind of registry.kinds()) {
    const runtime: Runtime = registry.get(kind);
    if (!runtime.registerWorkspace) continue;
    tasks.push(
      runtime.registerWorkspace(dir).catch((err) => {
        if (err instanceof RuntimeRegisterWorkspaceFailed) throw err;
        throw new RuntimeRegisterWorkspaceFailed(kind, dir, err as Error);
      }),
    );
  }
  await Promise.all(tasks);
}
