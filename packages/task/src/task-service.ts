/**
 * @emploke/task — `TaskService` facade.
 *
 * Thin orchestrator class. Each public method delegates to one of
 * five concern-specific modules under `./task-service/`:
 *   - `queries.ts`         — read-side (list, get, hasInFlight,
 *                             liveCount, resolveArtifactPath)
 *   - `activity-stream.ts` — runtime activity surface
 *   - `agent-resolver.ts`  — catalog/runtime resolution + spawn
 *                             internals shared by dispatch
 *   - `mutations.ts`       — write-side (dispatch, cancel, delete,
 *                             deleteForSchedule, recoverOrphaned)
 *   - `shutdown.ts`        — lifecycle hooks
 *
 * Shared state lives in a single `TaskServiceCtx` object built in
 * the constructor and passed to every internal function. The
 * `task-service/` subdir is implementation detail — not re-exported
 * from `./index.ts`.
 */

import { randomBytes as cryptoRandomBytes } from "node:crypto";
import path from "node:path";
import type { CatalogService } from "@emploke/catalog";
import type { RuntimeRegistry } from "@emploke/runtime";
import pino, { type Logger } from "pino";
import { tasksRoot } from "./paths.js";
import type { TaskEntity } from "./task-entity.js";
import { TaskRepository } from "./task-repository.js";
import { getTaskActivity, getTaskActivityStream } from "./task-service/activity-stream.js";
import type { LiveTask } from "./task-service/agent-resolver.js";
import {
  cancelTask,
  deleteTask,
  deleteTasksForSchedule,
  dispatchTask,
  recoverOrphaned,
} from "./task-service/mutations.js";
import {
  getTask,
  hasInFlightForSchedule,
  listTasks,
  liveCount,
  resolveArtifactPath,
} from "./task-service/queries.js";
import { drainPendingPurges, shutdownService } from "./task-service/shutdown.js";
import type { DispatchOpts, ListTaskOpts, TaskServiceConfig } from "./types.js";

const silentLogger = pino({ level: "silent" });

/** Default runtime kind used when a dispatch omits `opts.runtime`. */
export const DEFAULT_RUNTIME = "copilot";

/**
 * Shared state passed by the facade to every internal function.
 * `readonly` markers reflect identity-stability (the `Map`,
 * repository handle, logger etc. are never reassigned), NOT
 * deep-immutability — `live.set`, `dispatchInProgress.add`, and
 * mutation of `shuttingDown` / `purgeQueue` are how internals
 * coordinate cross-concern state.
 *
 * Exported for the internal `./task-service/*` files to import as
 * `import type`. NOT re-exported from `./index.ts`.
 */
export interface TaskServiceCtx {
  readonly catalog: CatalogService;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly tasksDir: string;
  readonly workspaceDir: string;
  readonly workspaceId: string;
  readonly repository: TaskRepository;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly randomBytes: (n: number) => Buffer;
  /** id → live record for tasks whose subprocess this manager still owns. */
  readonly live: Map<string, LiveTask>;
  /**
   * Ids whose `dispatch()` call is between workdir reservation and
   * the `live.set` at the end of dispatch. Surfaced via `liveCount`
   * so the workspace reload guard sees in-flight dispatches as
   * "live" and refuses to evict the cached manager.
   */
  readonly dispatchInProgress: Set<string>;
  /** True once `shutdown()` has been called; gates exit-watcher's status decision. */
  shuttingDown: boolean;
  /**
   * Serialised chain of background purges scheduled by
   * `scheduleBackgroundPurge`. Tests await its tail via
   * `_drainPendingPurgesForTest`. Per ADR-002 a single chained
   * promise replaces the original parallel `Set<Promise>` because
   * fs.rm of a copilot state dir on Windows pins a libuv worker for
   * tens of seconds.
   */
  purgeQueue: Promise<void>;
}

/**
 * Per-workspace registry of autonomous tasks.
 *
 * Owns `<tasksDir>/` on disk. Each task is one directory; queryable
 * metadata (status, runtime, agent, timings, the open-shape
 * `metadata` bag) lives in the per-workspace `workspace.db` `tasks`
 * table — one row per task, owned by `TaskRepository`. The runtime
 * keeps its own per-task event log on its own state directory
 * (Copilot: `<copilotStateDir>/<runtimeSessionId>/events.jsonl`).
 *
 * Responsibilities: reserve fresh id+workdir per dispatch; hand the
 * spawn off to the runtime; watch for exit and persist terminal
 * status; on shutdown kill+drain live subprocesses; on bootstrap
 * mark orphaned `running` tasks as failure. The `TaskEntity` value
 * type IS the FSM; this class orchestrates persistence + side
 * effects around it.
 */
export class TaskService {
  private readonly ctx: TaskServiceCtx;

  constructor(config: TaskServiceConfig) {
    const workspaceDir = path.resolve(config.workspaceDir);
    const logger = config.logger ?? silentLogger;
    this.ctx = {
      catalog: config.catalog,
      runtimeRegistry: config.runtimeRegistry,
      workspaceDir,
      tasksDir: tasksRoot(workspaceDir),
      workspaceId: config.workspaceId,
      repository: new TaskRepository({ db: config.db, logger }),
      logger,
      now: config.now ?? (() => new Date()),
      randomBytes: config.randomBytes ?? defaultRandomBytes,
      live: new Map(),
      dispatchInProgress: new Set(),
      shuttingDown: false,
      purgeQueue: Promise.resolve(),
    };
  }

  /**
   * @internal Back-compat seam for `cancel()`'s R-1 race test
   * (`task-service.cancel-during-dispatch-window.test.ts`) which
   * casts the instance to `{ dispatchInProgress: Set<string> }`.
   * Returns the same `Set` the ctx owns.
   */
  private get dispatchInProgress(): Set<string> {
    return this.ctx.dispatchInProgress;
  }

  async dispatch(opts: DispatchOpts): Promise<TaskEntity> {
    return dispatchTask(this.ctx, opts);
  }

  async list(opts: ListTaskOpts = {}): Promise<TaskEntity[]> {
    return listTasks(this.ctx, opts);
  }

  async hasInFlightForSchedule(scheduleId: string): Promise<boolean> {
    return hasInFlightForSchedule(this.ctx, scheduleId);
  }

  async deleteForSchedule(scheduleId: string): Promise<{ deletedCount: number }> {
    return deleteTasksForSchedule(this.ctx, scheduleId);
  }

  async get(id: string): Promise<TaskEntity | null> {
    return getTask(this.ctx, id);
  }

  async getTaskActivity(
    id: string,
    opts?: { readonly before?: number; readonly after?: number; readonly limit?: number },
  ): Promise<import("@emploke/runtime").ActivityResult | null> {
    return getTaskActivity(this.ctx, id, opts);
  }

  async getTaskActivityStream(
    id: string,
    opts: { readonly after?: number; readonly signal?: AbortSignal },
  ): Promise<AsyncIterable<import("@emploke/runtime").ActivityItem> | null> {
    return getTaskActivityStream(this.ctx, id, opts);
  }

  async cancel(id: string): Promise<TaskEntity> {
    return cancelTask(this.ctx, id);
  }

  async delete(id: string, opts: { purge?: boolean } = {}): Promise<void> {
    return deleteTask(this.ctx, id, opts);
  }

  /**
   * @internal Test-only: await all in-flight background purges
   * scheduled by `delete({ purge: true })`. Underscore prefix marks
   * this as a test seam, not public API.
   */
  async _drainPendingPurgesForTest(): Promise<void> {
    return drainPendingPurges(this.ctx);
  }

  async recoverOrphaned(): Promise<void> {
    return recoverOrphaned(this.ctx);
  }

  liveCount(): number {
    return liveCount(this.ctx);
  }

  async shutdown(): Promise<void> {
    return shutdownService(this.ctx);
  }

  /**
   * Release manager-owned resources. Currently a no-op — the DB
   * handle is owned by `composeTaskModule`. `shutdown()` does NOT
   * call this so consumers can still inspect persisted state after
   * shutdown. Idempotent. Kept on the public surface so future
   * callers don't break if manager-owned resources are added.
   */
  close(): void {
    // no-op — db lifecycle owned by composeTaskModule
  }

  async resolveArtifactPath(id: string, name: string): Promise<string | null> {
    return resolveArtifactPath(this.ctx, id, name);
  }
}

function defaultRandomBytes(n: number): Buffer {
  return cryptoRandomBytes(n);
}

/**
 * Pull a runtime-shaped session id from the task's open-shape
 * metadata bag. Returns null when the field is missing or not a
 * string. Lives on the facade module so queries, activity-stream,
 * and mutations can all share it without a 6th file.
 */
export function pickRuntimeSessionId(metadata: Readonly<Record<string, unknown>>): string | null {
  const v = metadata.runtimeSessionId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export type { TaskRuntimeMetadata } from "./task-meta.js";
export { readTaskRuntimeMetadata } from "./task-meta.js";
