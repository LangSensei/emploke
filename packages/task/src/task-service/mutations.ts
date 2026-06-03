import { mkdir, rm } from "node:fs/promises";
import type { Runtime } from "@emploke/runtime";
import {
  AgentNotFoundError,
  InvalidTransition,
  ManagerShuttingDownError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
} from "../errors.js";
import { safeJoinUnderRoot } from "../paths.js";
import type { TaskEntity } from "../task-entity.js";
import { DEFAULT_RUNTIME, pickRuntimeSessionId, type TaskServiceCtx } from "../task-service.js";
import type { DispatchOpts } from "../types.js";
import { assertValidTaskId, generateTaskId } from "../validate.js";
import { applyTerminal } from "./_helpers.js";
import { pickRuntime, resolveDispatchAgent } from "./agent-resolver.js";
import { runDispatch } from "./dispatch.js";

const MAX_CREATE_RETRIES = 5;

/**
 * Public dispatch entry. Resolves the agent, picks the runtime,
 * reserves a workdir on disk, registers the id in
 * `ctx.dispatchInProgress`, and hands off to `runDispatch` for the
 * spawn + post-spawn flow. Refuses with `ManagerShuttingDownError`
 * once `shutdown()` has been called so the HTTP route can map both
 * dispatch and cancel cleanly to 503.
 */
export async function dispatchTask(ctx: TaskServiceCtx, opts: DispatchOpts): Promise<TaskEntity> {
  if (ctx.shuttingDown) {
    throw new ManagerShuttingDownError();
  }

  // 1. Resolve agent. Bare-Error throws from the resolver are rewrapped
  //    so callers can `instanceof AgentNotFoundError` without losing the
  //    original cause.
  const agentName = opts.agent;
  if (typeof agentName !== "string" || agentName.length === 0) {
    throw new AgentNotFoundError(String(agentName));
  }
  const resolveResult = await resolveDispatchAgent(ctx, agentName);

  // 2. Pick the runtime + verify it supports tasks. Done before
  //    reserving the workdir so a misconfiguration doesn't litter
  //    empty dirs on disk.
  const runtimeKind = opts.runtime ?? DEFAULT_RUNTIME;
  const runtime = pickRuntime(ctx, runtimeKind);

  // 3. Reserve a workdir via exclusive mkdir, retrying on EEXIST.
  await mkdir(ctx.tasksDir, { recursive: true });
  let id: string | null = null;
  let workdir: string | null = null;
  for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
    const candidateId = generateTaskId(ctx.now, ctx.randomBytes);
    const candidateDir = safeJoinUnderRoot(ctx.tasksDir, candidateId);
    try {
      await mkdir(candidateDir, { recursive: false });
      id = candidateId;
      workdir = candidateDir;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      throw err;
    }
  }
  if (id === null || workdir === null) {
    throw new TaskIdAllocationFailedError(MAX_CREATE_RETRIES);
  }

  // From here the workdir exists on disk, so a freshly constructed
  // sibling `TaskService` for the same `tasksDir` — e.g. one built
  // after `WorkspaceContextRegistry.reload` evicts us — could see this
  // row. Mark `id` as in-flight so `liveCount()` refuses such
  // evictions until the `LiveTask` entry below is installed. Cleared
  // in the `finally` regardless of which exit path we take.
  ctx.dispatchInProgress.add(id);
  try {
    return await runDispatch(ctx, {
      id,
      workdir,
      agentName,
      brief: opts.brief,
      details: opts.details,
      origin: opts.origin ?? "standalone",
      runtime,
      resolveResult,
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    });
  } finally {
    ctx.dispatchInProgress.delete(id);
  }
}

/**
 * User-initiated cancellation of a live task. Kills the subprocess
 * (best-effort `handle.kill()`), awaits the exit watcher's terminal
 * persistence, and returns the cancelled `TaskEntity`.
 *
 * - Terminal-state input → `InvalidTransition` (route → 409).
 * - Concurrent same-id cancel: first call owns the kill; every
 *   subsequent call throws `InvalidTransition` after awaiting
 *   `live.settled`, so callers observe a consistent terminal state.
 * - Orphan path (no live entry): synthesises a terminal decision and
 *   routes through `applyTerminal` to mirror the normal-path row
 *   shape; warns so the operator knows `recoverOrphaned` missed it.
 * - Refuses with `InvalidTransition` if a dispatch for `id` is mid-
 *   flight (the row exists on disk but no `LiveTask` is wired yet),
 *   so the cancel cannot race past the just-spawned subprocess.
 * - Refuses while shutting down (`ManagerShuttingDownError` → 503).
 * - Throws `TaskNotFoundError` if id doesn't exist.
 */
export async function cancelTask(ctx: TaskServiceCtx, id: string): Promise<TaskEntity> {
  assertValidTaskId(id);
  if (ctx.shuttingDown) throw new ManagerShuttingDownError();

  if (ctx.dispatchInProgress.has(id)) {
    throw new InvalidTransition("running", "cancel-during-dispatch");
  }

  const workdir = safeJoinUnderRoot(ctx.tasksDir, id);
  const existing = await ctx.repository.read(id);
  if (existing === null) throw new TaskNotFoundError(id);
  if (
    existing.status === "succeeded" ||
    existing.status === "failed" ||
    existing.status === "cancelled"
  ) {
    throw new InvalidTransition(existing.status, "cancel");
  }

  const live = ctx.live.get(id);
  if (live !== undefined) {
    const wasFirstToCancel = live.killReason === null;
    if (wasFirstToCancel) {
      live.killReason = "cancel";
      try {
        live.handle.kill();
      } catch {
        // Already dead.
      }
    }
    try {
      await live.settled;
    } catch {
      // settled is constructed to never reject.
    }
    if (!wasFirstToCancel) {
      throw new InvalidTransition("cancelled", "cancel");
    }
  } else {
    // Orphan path: undetected by recoverOrphaned. Route through
    // applyTerminal with a synthesised decision so the persisted row
    // shape matches the normal-path output. The orphan flavour is
    // recorded as `cascade` because no caller branches on a separate
    // orphan-cancellation kind.
    ctx.logger.warn(
      { taskId: id },
      "tasks: cancelling row in running status with no live subprocess (orphan)",
    );
    await applyTerminal(ctx, workdir, existing, {
      kind: "cancelled",
      cancellation: {
        kind: "cascade",
        message: "cancelled (recovered from inconsistent state)",
      },
    });
  }

  const final = await ctx.repository.read(id);
  if (final === null) throw new TaskNotFoundError(id);
  return final;
}

/**
 * Remove a task. This verb only ever removes records — it never
 * touches subprocesses. The task MUST be in a terminal status;
 * non-terminal input throws `InvalidTransition` (route → 409).
 *
 * Default ("archive") drops only the metadata row; the workdir stays
 * on disk so the user can inspect agent artifacts. `{ purge: true }`
 * also schedules a serialised background `runtime.deleteState` +
 * `rm -rf workdir`. Background failures are warn-logged; orphan dirs
 * remain recoverable via the workspace's `sqlite3` CLI as the
 * recovery channel. Stays fire-and-forget because Windows `fs.rm` of
 * a copilot state dir can take tens of seconds.
 *
 * Throws `TaskNotFoundError` when id doesn't exist.
 */
export async function deleteTask(
  ctx: TaskServiceCtx,
  id: string,
  opts: { purge?: boolean } = {},
): Promise<void> {
  assertValidTaskId(id);
  const workdir = safeJoinUnderRoot(ctx.tasksDir, id);

  const existing = await ctx.repository.read(id);
  if (existing === null) {
    throw new TaskNotFoundError(id);
  }
  if (
    existing.status !== "succeeded" &&
    existing.status !== "failed" &&
    existing.status !== "cancelled"
  ) {
    // delete requires terminal status. Cancel the task first before
    // deleting.
    throw new InvalidTransition(existing.status, "delete");
  }

  // DB row removal IS the "task is deleted" semantic; the user-facing
  // 204 hinges on this. Done synchronously so a successful resolve
  // means "this task no longer exists from the API's POV".
  await ctx.repository.delete(id);

  if (opts.purge === true) {
    scheduleBackgroundPurge(ctx, id, existing, workdir);
  }
}

/**
 * Cascade-delete every TERMINAL task with `origin='schedule'` and
 * `metadata.scheduleId === scheduleId`. Called by `ScheduleService.delete`
 * so historical fires don't outlive the schedule that produced them.
 *
 * Workdir cleanup mirrors `delete(id, { purge: true })`: each task's
 * workdir enqueues on the serialised `purgeQueue`. In-flight tasks
 * are never touched — the terminal filter inside
 * `deleteTerminalForSchedule` ignores them; the caller is responsible
 * for the no-in-flight precondition.
 */
export async function deleteTasksForSchedule(
  ctx: TaskServiceCtx,
  scheduleId: string,
): Promise<{ deletedCount: number }> {
  const deleted = await ctx.repository.deleteTerminalForSchedule(scheduleId);
  for (const task of deleted) {
    const workdir = safeJoinUnderRoot(ctx.tasksDir, task.id);
    scheduleBackgroundPurge(ctx, task.id, task, workdir);
  }
  return { deletedCount: deleted.length };
}

/**
 * Sweep persisted tasks still in `running` status at server boot and
 * mark them `failure: { kind: 'orphan' }`. Catches the server-crash
 * case (OOM, segfault, `kill -9`); normal stop/reload runs
 * `gracefulShutdown` which already terminates everything. Lifecycle
 * invariant: the SDK CLI subprocess is a child of the emploke
 * server, so a server death implies the subprocess is gone too — no
 * per-task liveness probe is needed.
 */
export async function recoverOrphaned(ctx: TaskServiceCtx): Promise<void> {
  let candidates: TaskEntity[];
  try {
    candidates = await ctx.repository.list({ statuses: ["running"] });
  } catch (err) {
    ctx.logger.warn({ err }, "tasks: recoverOrphaned repository.list failed");
    return;
  }

  await Promise.all(
    candidates.map(async (task) => {
      const id = task.id;
      try {
        const failed = task.fail(
          {
            kind: "orphan",
            message: "orphaned (server crashed before this task ended)",
          },
          { now: ctx.now().toISOString() },
        );
        await ctx.repository.save(failed);
      } catch (err) {
        ctx.logger.warn({ taskId: id, err }, "tasks: failed to mark orphaned task as failure");
      }
    }),
  );
}

/**
 * Chain a workdir + runtime-state purge onto the serial
 * `ctx.purgeQueue`. A single chained promise (rather than a parallel
 * `Set<Promise>`) keeps fs.rm of a copilot state dir from saturating
 * the libuv worker pool — on Windows a single such rm pins a worker
 * for tens of seconds. Both continuations re-enqueue so a prior
 * failure never stalls the queue.
 */
export function scheduleBackgroundPurge(
  ctx: TaskServiceCtx,
  id: string,
  existing: TaskEntity,
  workdir: string,
): void {
  ctx.purgeQueue = ctx.purgeQueue.then(
    () => runBackgroundPurge(ctx, id, existing, workdir),
    () => runBackgroundPurge(ctx, id, existing, workdir),
  );
}

async function runBackgroundPurge(
  ctx: TaskServiceCtx,
  id: string,
  existing: TaskEntity,
  workdir: string,
): Promise<void> {
  const runtimeName = existing.metadata.runtime;
  const runtimeKey = typeof runtimeName === "string" ? runtimeName : DEFAULT_RUNTIME;
  let runtime: Runtime | undefined;
  try {
    runtime = ctx.runtimeRegistry.get(runtimeKey);
  } catch {
    // Unknown runtime (e.g. dropped from registry between dispatch
    // and delete): skip the runtime-side delete; still rm the workdir.
    runtime = undefined;
  }

  if (runtime !== undefined && typeof runtime.deleteState === "function") {
    const runtimeSessionId = pickRuntimeSessionId(existing.metadata);
    if (runtimeSessionId !== null) {
      try {
        await runtime.deleteState(runtimeSessionId);
      } catch (err) {
        ctx.logger.warn(
          { err, taskId: id, runtimeSessionId },
          "task.purge: runtime.deleteState failed; orphan runtime state dir may remain",
        );
      }
    }
  }

  try {
    await rm(workdir, { recursive: true, force: true });
  } catch (err) {
    ctx.logger.warn(
      { err, taskId: id, workdir },
      "task.purge: workdir rm failed; orphan task workdir may remain",
    );
  }
}
