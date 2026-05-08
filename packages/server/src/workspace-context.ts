import path from "node:path";
import type { Catalog } from "@emploke/catalog";
import {
  type Runtime,
  RuntimeRegisterWorkspaceFailed,
  type RuntimeRegistry,
} from "@emploke/runtime";
import { SessionManager } from "@emploke/session";
import { type Workspace, WorkspaceManager, type WorkspaceRegistry } from "@emploke/workspace";

/**
 * Per-workspace bundle of long-lived state. The server caches one of these
 * per registered workspace and hands it to route handlers via Hono context.
 *
 * `sessions` is constructed against the workspace's `sessionsDir`; future
 * managers (tasks, workflows) will join this struct as siblings.
 */
export interface WorkspaceContext {
  readonly workspace: Workspace;
  readonly sessions: SessionManager;
}

/**
 * Lazy, memoised resolver from URL workspace name to a `WorkspaceContext`.
 *
 * Lookup flow on a cache miss:
 *   1. Validate that `name` is in the home-level `WorkspaceRegistry`. If
 *      not, return null — the route handler will respond 404.
 *   2. `WorkspaceManager.open()` the registered path. Throws on missing /
 *      corrupted `workspace.json`; the route handler converts to 5xx.
 *   3. Call `Runtime.registerWorkspace?` on every registered runtime so
 *      one-time setup (e.g. trust) happens before any session actually
 *      runs in this workspace. Failures wrap as `RuntimeRegisterWorkspaceFailed`.
 *   4. Build a `SessionManager` pointed at `<workspace>/sessions/`.
 *   5. Cache the bundle keyed by the URL name.
 *
 * We cache by name (URL identifier) rather than by absolute path so a
 * stale cache entry can be expired with `invalidate(name)` when the
 * registry mutates (rename/delete).
 */
export class WorkspaceContextCache {
  private readonly catalog: Catalog;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly registry: WorkspaceRegistry;
  private readonly entries = new Map<string, WorkspaceContext>();
  /**
   * Inflight lookups keyed by name, to dedupe concurrent first-request
   * stampedes (the `registerWorkspace` calls each runtime makes can be
   * expensive — we don't want N parallel calls for one workspace).
   */
  private readonly inflight = new Map<string, Promise<WorkspaceContext | null>>();

  constructor(deps: {
    catalog: Catalog;
    runtimeRegistry: RuntimeRegistry;
    registry: WorkspaceRegistry;
  }) {
    this.catalog = deps.catalog;
    this.runtimeRegistry = deps.runtimeRegistry;
    this.registry = deps.registry;
  }

  /**
   * Resolve a registered workspace by URL name. Returns null if no entry
   * exists with that name. Throws on workspace.json read failures or
   * runtime setup failures (the route handler maps to 5xx).
   */
  async get(name: string): Promise<WorkspaceContext | null> {
    const cached = this.entries.get(name);
    if (cached) return cached;

    const inflight = this.inflight.get(name);
    if (inflight) return inflight;

    const promise = this.load(name).finally(() => {
      this.inflight.delete(name);
    });
    this.inflight.set(name, promise);
    return promise;
  }

  /**
   * Drop the cached context for `name`. Safe to call when no entry exists.
   * Invoked by routes that mutate registry state (remove, rename) so the
   * next request sees a fresh world.
   */
  invalidate(name: string): void {
    this.entries.delete(name);
  }

  private async load(name: string): Promise<WorkspaceContext | null> {
    const entry = this.registry.get(name);
    if (!entry) return null;

    const workspace = await WorkspaceManager.open(entry.path);
    await registerWorkspaceWithRuntimes(this.runtimeRegistry, workspace.dir);

    const sessions = new SessionManager({
      catalog: this.catalog,
      runtimeRegistry: this.runtimeRegistry,
      sessionsDir: workspace.sessionsDir,
    });

    const ctx: WorkspaceContext = { workspace, sessions };
    this.entries.set(name, ctx);
    return ctx;
  }
}

/**
 * Call `registerWorkspace` on every runtime that implements it. Runtimes
 * without the optional method are skipped silently. Failures wrap into
 * `RuntimeRegisterWorkspaceFailed` so callers see a typed error.
 *
 * Exported for `index.ts` bootstrap (which warms registrations for known
 * workspaces eagerly) and for tests.
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
