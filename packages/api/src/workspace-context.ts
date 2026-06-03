import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type CatalogService, composeCatalogModule } from "@emploke/catalog";
import type { RuntimeRegistry } from "@emploke/runtime";
import { composeScheduleModule, type ScheduleService } from "@emploke/schedule";
import {
  composeSessionModule,
  type SessionService,
  type SpawnSessionResult as SessionSpawnSessionResult,
  type SpawnFn,
} from "@emploke/session";
import { composeTaskModule, type TaskService } from "@emploke/task";
import type { Workspace, WorkspaceService } from "@emploke/workspace";
import pino, { type Logger } from "pino";
import { makeTaskKindHandler } from "./wiring/schedule-task-handler.js";

const silentLogger: Logger = pino({ level: "silent" });

/**
 * Result of {@link SessionService.spawnInteractive} — the canonical
 * "start an interactive session" call site.
 *
 * @deprecated Re-exported from `@emploke/session` for one minor cycle
 * to preserve the published type-import surface for external
 * consumers. New code SHOULD import `SpawnSessionResult` from
 * `@emploke/session` directly. The api-side re-export will be removed
 * in the next minor after consumers migrate.
 */
export type SpawnSessionResult = SessionSpawnSessionResult;

/**
 * Thrown by `WorkspaceContextRegistry.reload` when the cached context
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
 *
 * "Start an interactive session" semantics live on
 * `sessions.spawnInteractive(sid, opts)` — callers reach the spawner
 * via `ctx.sessions.spawnInteractive(...)`.
 */
export interface WorkspaceContext {
  readonly workspace: Workspace;
  readonly catalog: CatalogService;
  readonly sessions: SessionService;
  readonly tasks: TaskService;
  /**
   * Per-workspace cron-driven task dispatch substrate. The timer is
   * armed in `load()` via `service.recover()` (catchup-once on boot)
   * and torn down before tasks in `close()` so a fire in flight
   * doesn't race a closed `TaskService`.
   */
  readonly schedules: ScheduleService;
  /** Closes all backing connections. Idempotent. */
  close(): Promise<void>;
}

/**
 * Lazy, memoised resolver from URL workspace id (UUID) to a
 * `WorkspaceContext`. Builds per-workspace SQLite handles + services on
 * first touch, caches them for subsequent requests.
 *
 * This class is the source-of-truth registry of live per-workspace
 * bundles (SQLite handles, task supervisors, SSE event buses). It is
 * NOT an optimisation cache that can be silently dropped — dropping
 * entries without `close()` leaks live resources.
 *
 * Internal to `@emploke/api`. Consumers go through `Application`
 * methods (`getContext`, `loadedContexts`, `reloadWorkspace`,
 * `unregisterWorkspace`, `close`); the registry is not exported from
 * the package surface.
 */
export class WorkspaceContextRegistry {
  private readonly workspaceService: WorkspaceService;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly spawnFn: SpawnFn;
  private readonly logger: Logger;
  private readonly entries = new Map<string, WorkspaceContext>();
  private readonly inflight = new Map<string, Promise<WorkspaceContext | null>>();

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

  async invalidate(id: string): Promise<void> {
    // Drain any in-flight load FIRST. Same race as reload() — without
    // this drain, a concurrent `get(id)` whose `load()` resolves after
    // we run `entries.delete(id)` will store the stale context AFTER
    // the invalidate completed, leaking the freshly-built context
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

  async reload(id: string): Promise<WorkspaceContext | null> {
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

  loaded(): WorkspaceContext[] {
    return [...this.entries.values()];
  }

  async closeAll(): Promise<void> {
    // Drain in-flight loads first. Without this, a concurrent
    // `get(id)` whose promise resolves AFTER our iteration over
    // `entries` would re-populate the map post-close and leak the
    // newly-built context past process exit. Same drain-then-act
    // pattern used by `reload(id)`.
    const inflight = [...this.inflight.values()];
    for (const p of inflight) {
      try {
        await p;
      } catch {
        // best-effort
      }
    }
    for (const ctx of this.entries.values()) {
      try {
        await ctx.close();
      } catch {
        // best-effort
      }
    }
    this.entries.clear();
  }

  private async load(id: string): Promise<WorkspaceContext | null> {
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
    let scheduleModule: Awaited<ReturnType<typeof composeScheduleModule>>;
    try {
      catalogModule = await composeCatalogModule({
        dbFile,
        logger: this.logger,
      });
      cleanup.push(() => catalogModule.close());
      sessionModule = await composeSessionModule({
        dbFile,
        agentResolver: catalogModule.service,
        contentSource: catalogModule.service,
        runtimeRegistry: this.runtimeRegistry,
        workspaceDir: workspace.workspaceDir,
        workspaceId: id,
        logger: this.logger,
        spawnFn: this.spawnFn,
      });
      cleanup.push(() => sessionModule.close());
      taskModule = await composeTaskModule({
        dbFile,
        agentResolver: catalogModule.service,
        contentSource: catalogModule.service,
        runtimeRegistry: this.runtimeRegistry,
        workspaceDir: workspace.workspaceDir,
        workspaceId: id,
        logger: this.logger,
      });
      cleanup.push(() => taskModule.close());

      // Schedules are composed AFTER tasks so the kind handler's
      // `dispatch` / `hasInFlightForSchedule` / `deleteForSchedule`
      // can bridge to a live `TaskService`. The same workspace.db
      // file is reused (WAL-mode shared connection); migrations are
      // idempotent.
      scheduleModule = await composeScheduleModule({
        dbFile,
        logger: this.logger,
      });
      cleanup.push(() => scheduleModule.close());

      await taskModule.service.recoverOrphaned();
      // Register every kind BEFORE recover(). recover() freezes the
      // registry and preflights every persisted row's target_kind
      // against it — any row with an unregistered kind throws
      // ScheduleKindNotRegisteredError naming the kind + the
      // register-before-recover requirement. The order is also
      // load-bearing for the catchup path: a catchup fire (next
      // fire in the past at boot) needs the freshly-reconciled
      // task list when it checks hasInFlightForSchedule.
      scheduleModule.service.registerKind(
        "task",
        makeTaskKindHandler({
          tasks: taskModule.service,
          catalog: catalogModule.service,
        }),
      );
      await scheduleModule.service.recover();
    } catch (err) {
      await teardown();
      throw err;
    }

    const outerLogger = this.logger;
    const context: WorkspaceContext = {
      workspace,
      catalog: catalogModule.service,
      sessions: sessionModule.service,
      tasks: taskModule.service,
      schedules: scheduleModule.service,
      async close() {
        // Per-module try/catch: a throw from one module's close()
        // must NOT skip the others. Without per-module catches a
        // `taskModule.close()` throw would leak the session +
        // catalog SQLite handles. Same all-or-nothing disposal
        // idiom as load()'s cleanup stack.
        //
        // Ordering: schedule FIRST (reverse of compose). schedule's
        // close() awaits `service.shutdown()`, which clears the
        // in-flight setTimeout queue; closing it before tasks means
        // no new fires can land on a torn-down TaskService.
        //
        // Multi-error handling: the FIRST error is re-thrown so the
        // caller sees something; LATER errors are logged via the
        // pkg's `silentLogger`-or-injected logger so a wedged 2nd
        // module isn't lost.
        const errors: unknown[] = [];
        try {
          await scheduleModule.close();
        } catch (err) {
          errors.push(err);
        }
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
    this.entries.set(id, context);
    this.logger.info(
      { workspaceId: id, workspaceDir: workspace.workspaceDir, dbPath: dbFile },
      "per-workspace container built (first request)",
    );
    return context;
  }
}
