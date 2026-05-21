import path from "node:path";
import {
  type CatalogManager,
  composeCatalogModule,
} from "@emploke/catalog";
import { type Logger, silentLogger } from "@emploke/logger";
import type { RuntimeRegistry } from "@emploke/runtime";
import {
  composeSessionModule,
  type SessionManager,
} from "@emploke/session";
import {
  composeTaskModule,
  type TaskManager,
} from "@emploke/task";
import {
  composeWorkspaceModule,
  type WorkspaceModuleOptions,
  type WorkspaceQueries,
  type WorkspaceService,
  type WorkspaceView,
  workspaceLayout,
} from "@emploke/workspace";

/**
 * Thrown by `WorkspaceRuntimeCache.reload` when the cached runtime
 * still has live task subprocesses being supervised by its
 * `TaskManager`. Reload would orphan them.
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
 * Per-workspace bundle of long-lived state. Holds three MikroORM
 * instances (one per BC against the same `workspace.db` file via WAL)
 * and the rich managers built on top.
 */
export interface WorkspaceRuntime {
  readonly workspace: WorkspaceView;
  readonly catalog: CatalogManager;
  readonly sessions: SessionManager;
  readonly tasks: TaskManager;
  /** Closes all three ORMs. Idempotent. */
  close(): Promise<void>;
}

/**
 * Composition root for the global registry plus on-demand
 * per-workspace runtimes. The server (and future CLI / MCP / SDK
 * consumers) call `composeEmplokeCore({...})` once and route every
 * per-workspace request through the returned cache.
 */
export interface EmplokeCore {
  readonly workspaceService: WorkspaceService;
  readonly workspaceQueries: WorkspaceQueries;
  readonly runtimes: WorkspaceRuntimeCache;
  /** Closes the global registry ORM. Cache must be `closeAll()`'d first. */
  close(): Promise<void>;
}

export interface EmplokeCoreOptions {
  readonly workspace: WorkspaceModuleOptions;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly subprocessEnvBase?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
}

export async function composeEmplokeCore(opts: EmplokeCoreOptions): Promise<EmplokeCore> {
  const workspaceModule = await composeWorkspaceModule(opts.workspace);
  const cache = new WorkspaceRuntimeCache({
    queries: workspaceModule.queries,
    runtimeRegistry: opts.runtimeRegistry,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(opts.subprocessEnvBase !== undefined
      ? { subprocessEnvBase: opts.subprocessEnvBase }
      : {}),
  });
  return {
    workspaceService: workspaceModule.service,
    workspaceQueries: workspaceModule.queries,
    runtimes: cache,
    async close() {
      await workspaceModule.close();
    },
  };
}

/**
 * Lazy, memoised resolver from URL workspace id (UUID) to a
 * `WorkspaceRuntime`. Builds per-workspace ORMs + managers on first
 * touch, caches them for subsequent requests.
 */
export class WorkspaceRuntimeCache {
  private readonly queries: WorkspaceQueries;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly logger: Logger;
  private readonly subprocessEnvBase: NodeJS.ProcessEnv;
  private readonly entries = new Map<string, WorkspaceRuntime>();
  private readonly inflight = new Map<string, Promise<WorkspaceRuntime | null>>();

  constructor(deps: {
    queries: WorkspaceQueries;
    runtimeRegistry: RuntimeRegistry;
    logger?: Logger;
    subprocessEnvBase?: NodeJS.ProcessEnv;
  }) {
    this.queries = deps.queries;
    this.runtimeRegistry = deps.runtimeRegistry;
    this.logger = deps.logger ?? silentLogger;
    this.subprocessEnvBase = deps.subprocessEnvBase ?? {};
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
    const workspace = await this.queries.getById(id);
    if (!workspace) return null;

    const layout = workspaceLayout(workspace.workspaceDir);
    const dbFile = path.join(workspace.workspaceDir, "workspace.db");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace.workspaceDir, { recursive: true });

    const catalogModule = await composeCatalogModule({
      dbFile,
      logger: this.logger,
    });
    const sessionModule = await composeSessionModule({
      dbFile,
      catalog: catalogModule.manager,
      runtimeRegistry: this.runtimeRegistry,
      sessionsDir: layout.sessions,
      workspaceDir: workspace.workspaceDir,
      workspaceId: id,
      subprocessEnv: this.subprocessEnvBase,
      logger: this.logger,
    });
    const taskModule = await composeTaskModule({
      dbFile,
      catalog: catalogModule.manager,
      runtimeRegistry: this.runtimeRegistry,
      tasksDir: layout.tasks,
      workspaceDir: workspace.workspaceDir,
      workspaceId: id,
      subprocessEnv: this.subprocessEnvBase,
      logger: this.logger,
    });

    await taskModule.manager.recoverOrphaned();

    const runtime: WorkspaceRuntime = {
      workspace,
      catalog: catalogModule.manager,
      sessions: sessionModule.manager,
      tasks: taskModule.manager,
      async close() {
        await taskModule.close();
        await sessionModule.close();
        await catalogModule.close();
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
