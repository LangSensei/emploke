import path from "node:path";
import { type CatalogService, composeCatalogModule } from "@emploke/catalog";
import pino, { type Logger } from "pino";

const silentLogger: Logger = pino({ level: "silent" });

import type { RuntimeRegistry } from "@emploke/runtime";
import { composeSessionModule, type SessionService } from "@emploke/session";
import { composeTaskModule, type TaskService } from "@emploke/task";
import {
  composeWorkspaceModule,
  type Workspace,
  type WorkspaceModuleOptions,
  type WorkspaceService,
} from "@emploke/workspace";

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
 * services (one per BC, sharing one `workspace.db` via WAL).
 */
export interface WorkspaceRuntime {
  readonly workspace: Workspace;
  readonly catalog: CatalogService;
  readonly sessions: SessionService;
  readonly tasks: TaskService;
  /** Closes all backing connections. Idempotent. */
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
  readonly runtimes: WorkspaceRuntimeCache;
  /** Closes the global registry connection. Cache must be `closeAll()`'d first. */
  close(): Promise<void>;
}

export interface EmplokeCoreOptions {
  readonly workspace: WorkspaceModuleOptions;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly logger?: Logger;
}

export async function composeEmplokeCore(opts: EmplokeCoreOptions): Promise<EmplokeCore> {
  const workspaceModule = await composeWorkspaceModule(opts.workspace);
  const cache = new WorkspaceRuntimeCache({
    workspaceService: workspaceModule.service,
    runtimeRegistry: opts.runtimeRegistry,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  return {
    workspaceService: workspaceModule.service,
    runtimes: cache,
    async close() {
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
  private readonly logger: Logger;
  private readonly entries = new Map<string, WorkspaceRuntime>();
  private readonly inflight = new Map<string, Promise<WorkspaceRuntime | null>>();

  constructor(deps: {
    workspaceService: WorkspaceService;
    runtimeRegistry: RuntimeRegistry;
    logger?: Logger;
  }) {
    this.workspaceService = deps.workspaceService;
    this.runtimeRegistry = deps.runtimeRegistry;
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
    const workspace = await this.workspaceService.getById(id);
    if (!workspace) return null;

    const dbFile = path.join(workspace.workspaceDir, "workspace.db");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace.workspaceDir, { recursive: true });

    const catalogModule = await composeCatalogModule({
      dbFile,
      logger: this.logger,
    });
    const sessionModule = await composeSessionModule({
      dbFile,
      catalog: catalogModule.service,
      runtimeRegistry: this.runtimeRegistry,
      workspaceDir: workspace.workspaceDir,
      workspaceId: id,
      logger: this.logger,
    });
    const taskModule = await composeTaskModule({
      dbFile,
      catalog: catalogModule.service,
      runtimeRegistry: this.runtimeRegistry,
      workspaceDir: workspace.workspaceDir,
      workspaceId: id,
      logger: this.logger,
    });

    await taskModule.service.recoverOrphaned();

    const runtime: WorkspaceRuntime = {
      workspace,
      catalog: catalogModule.service,
      sessions: sessionModule.service,
      tasks: taskModule.service,
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
