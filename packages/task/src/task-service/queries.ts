import path from "node:path";
import type { Runtime } from "@emploke/runtime";
import type { TaskEntity } from "../task-entity.js";
import { pickRuntimeSessionId, type TaskServiceCtx } from "../task-service.js";
import type { ListTaskOpts } from "../types.js";
import { assertValidTaskId } from "../validate.js";

/**
 * List persisted tasks newest first. Cheap reads only — no runtime
 * introspection. All filters (status, agent, runtime, createdSince)
 * are pushed down to the SQLite repository so the dashboard's filter
 * UI hits a single indexed query rather than O(N) readdir + filter
 * in JS. Corrupted rows are silently dropped + warn-logged from the
 * repository layer.
 */
export async function listTasks(
  ctx: TaskServiceCtx,
  opts: ListTaskOpts = {},
): Promise<TaskEntity[]> {
  let tasks: TaskEntity[];
  try {
    tasks = await ctx.repository.list(opts);
  } catch (err) {
    ctx.logger.warn({ err }, "tasks: repository.list failed");
    return [];
  }

  // Newest first. createdAt is ISO 8601 → lexicographic sort. Id is
  // the deterministic tiebreaker for tasks created in the same
  // millisecond. (We sort here rather than in the repository so the
  // sort order stays consistent across future repo backends.)
  tasks.sort((a, b) => {
    const d = b.createdAt.localeCompare(a.createdAt);
    return d !== 0 ? d : b.id.localeCompare(a.id);
  });

  // Runtime metadata enrichment fans out one runtime.readMetadata
  // call per row, which at workspace scale saturated the libuv pool
  // and serialised purge fs.rm; `lastActiveAtRuntime` enrichment
  // now lives on `get()` and only fires when status==='running'.
  return tasks;
}

/**
 * True if any non-terminal task with `origin='schedule'` and
 * `metadata.scheduleId === scheduleId` exists. Used by the
 * scheduler's concurrency=1 check and the delete-schedule guard.
 * Cheap thanks to the `tasks_schedule_id_idx` functional index.
 */
export async function hasInFlightForSchedule(
  ctx: TaskServiceCtx,
  scheduleId: string,
): Promise<boolean> {
  return ctx.repository.hasInFlightForSchedule(scheduleId);
}

/**
 * True if any non-terminal task with `origin='workflow'` and
 * `metadata.workflowNodeId === nodeId` exists. Used by the workflow
 * worker runner's `hasInFlightForNode` implementation (see
 * `packages/api/src/wiring/workflow-task-runner.ts`). Narrow
 * additive surface mirroring {@link hasInFlightForSchedule} —
 * deliberately NOT a generic `metadata` filter on `ListTaskOpts` so
 * the broadening stays contained to the one call site that needs
 * it.
 */
export async function hasInFlightForWorkflowNode(
  ctx: TaskServiceCtx,
  nodeId: string,
): Promise<boolean> {
  return ctx.repository.hasInFlightForWorkflowNode(nodeId);
}

/**
 * List non-terminal tasks for a workflow node. Used by the worker
 * runner's `cancel(nodeId)` reverse-lookup. Returns full entities
 * because the caller needs `task.id` to call `tasks.cancel(...)`.
 */
export async function listInFlightForWorkflowNode(
  ctx: TaskServiceCtx,
  nodeId: string,
): Promise<TaskEntity[]> {
  return ctx.repository.listInFlightForWorkflowNode(nodeId);
}

/**
 * Find the most recent task — terminal or not — for a workflow
 * node. Used by the wire-shape projector for the workflow `/dag`
 * route so each `WorkflowNodeWire` can carry its dispatched
 * `taskId` for dashboard Mode B drill-down. See
 * {@link TaskRepository.findTaskByWorkflowNode} for the predicate
 * shape (no terminal filter, ORDER BY createdAt DESC LIMIT 1).
 */
export async function findTaskByWorkflowNode(
  ctx: TaskServiceCtx,
  nodeId: string,
): Promise<TaskEntity | null> {
  return ctx.repository.findTaskByWorkflowNode(nodeId);
}

export async function getTask(ctx: TaskServiceCtx, id: string): Promise<TaskEntity | null> {
  assertValidTaskId(id);
  const task = await ctx.repository.read(id);
  if (task === null) return null;
  // Only running tasks have a meaningful `lastActiveAtRuntime`. For
  // terminal tasks the runtime state dir may already be gone (purge
  // runs in background).
  if (task.status !== "running") return task;
  return enrichWithRuntimeMetadata(ctx, task);
}

/**
 * Number of tasks the manager is currently supervising — both fully
 * "live" entries (subprocess spawned, exit watcher armed) and
 * dispatches mid-flight (workdir reserved, on-disk row written, not
 * yet registered in `live`). Counted from `mkdir(workdir)` in
 * `dispatch()` until either rollback or terminal persistence.
 *
 * Used by callers that need to refuse destructive operations during
 * live work — e.g. workspace cache reload, where evicting the
 * cached `WorkspaceContext` mid-task would orphan the subprocess.
 * The `dispatchInProgress` summand closes the window between
 * `mkdir(workdir)` and `live.set` (see `TaskServiceCtx` jsdoc).
 */
export function liveCount(ctx: TaskServiceCtx): number {
  return ctx.live.size + ctx.dispatchInProgress.size;
}

/**
 * Resolve a downloadable artifact for a terminal task. Returns the
 * absolute fs path when the named artifact is on the task's
 * whitelist (`task.success.artifacts`), or `null` when the task is
 * unknown / non-terminal / missing the artifact. Caller (server
 * route) maps `null` to 404 and streams the path.
 *
 * The whitelist check is the actual security boundary; the route
 * layer also rejects path traversal in the request name, and we
 * normalise with `path.basename` here as defence in depth.
 */
export async function resolveArtifactPath(
  ctx: TaskServiceCtx,
  id: string,
  name: string,
): Promise<string | null> {
  assertValidTaskId(id);
  const task = await getTask(ctx, id);
  if (task === null) return null;
  if (task.status === "running") return null;
  const allowed = task.success?.artifacts ?? [];
  // Match by basename — the persisted entries are absolute paths
  // under `<workdir>/artifact/`; HTTP callers only ever know the
  // leaf filename. `path.basename` normalises both unix and
  // windows separators so cross-platform persisted rows resolve
  // identically.
  const requested = path.basename(name);
  if (requested === "" || requested === "." || requested === "..") return null;
  const match = allowed.find((abs) => path.basename(abs) === requested);
  if (match === undefined) return null;
  return match;
}

/**
 * Fold runtime-supplied `lastActiveAtRuntime` into a loaded task.
 * Pure — never mutates input; never persists. Returns the input task
 * unchanged when the runtime is unknown/unregistered, doesn't
 * implement `readMetadata`, returns null, or throws (warn-logged).
 *
 * Legacy `metadata.title` / `metadata.userTitled` keys are NOT
 * injected here — the Copilot-generated session `name` reflects the
 * framing prompt, not the user's task; the `TaskEntity.brief` field
 * is the source of truth for the display label.
 */
async function enrichWithRuntimeMetadata(
  ctx: TaskServiceCtx,
  task: TaskEntity,
): Promise<TaskEntity> {
  const runtimeName = task.metadata.runtime;
  if (typeof runtimeName !== "string") return task;
  let runtime: Runtime;
  try {
    runtime = ctx.runtimeRegistry.get(runtimeName);
  } catch {
    return task;
  }
  if (typeof runtime.readMetadata !== "function") return task;
  const runtimeSessionId = pickRuntimeSessionId(task.metadata);
  if (runtimeSessionId === null) return task;
  let meta: Awaited<ReturnType<NonNullable<Runtime["readMetadata"]>>>;
  try {
    meta = await runtime.readMetadata(runtimeSessionId);
  } catch (err) {
    // lastActiveAtRuntime is best-effort; don't break list/get on a
    // runtime fault.
    ctx.logger.warn(
      {
        taskId: task.id,
        runtime: runtimeName,
        err,
      },
      "tasks: readMetadata failed",
    );
    return task;
  }
  if (meta === null) return task;
  if (meta.lastActiveAt === null) return task;
  // Open-shape merge — only set the keys we care about, preserve
  // everything else verbatim.
  const enriched: Record<string, unknown> = {
    ...task.metadata,
    lastActiveAtRuntime: meta.lastActiveAt,
  };
  return task.withMetadata(enriched);
}
