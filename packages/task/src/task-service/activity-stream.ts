import type { ActivityItem, ActivityResult, Runtime } from "@emploke/runtime";
import { readTaskRuntimeMetadata } from "../task-meta.js";
import { pickRuntimeSessionId, type TaskServiceCtx } from "../task-service.js";
import { assertValidTaskId } from "../validate.js";

/**
 * Fetch a task's activity timeline + derived headline result via
 * the runtime's structured activity surface. Returns `null` when:
 *   - the task is missing or its metadata is corrupted,
 *   - the runtime is no longer registered,
 *   - the runtime doesn't implement `readActivity` (no structured
 *     log support),
 *   - the runtime has no log for this task yet (task hasn't started,
 *     or started but hasn't emitted its first event).
 *
 * The route layer maps `null` to 404 NoEventsYet.
 *
 * Pagination is owned by the runtime (it's the only layer that
 * knows its own log layout); the manager just forwards
 * `before` / `after` / `limit` and the runtime's `truncated` marker.
 * The server route enforces the [1, 500] limit clamp and the
 * `before`/`after` mutex before reaching here.
 *
 * Read errors after the runtime found its log (e.g. permission
 * error mid-read) propagate; they're true server faults and should
 * surface as 500.
 */
export async function getTaskActivity(
  ctx: TaskServiceCtx,
  id: string,
  opts?: { readonly before?: number; readonly after?: number; readonly limit?: number },
): Promise<ActivityResult | null> {
  assertValidTaskId(id);
  const task = await ctx.repository.read(id);
  if (task === null) return null;
  const meta = readTaskRuntimeMetadata(task);
  if (typeof meta.runtime !== "string") return null;
  const runtimeSessionId = pickRuntimeSessionId(task.metadata);
  if (runtimeSessionId === null) return null;
  let runtime: Runtime;
  try {
    runtime = ctx.runtimeRegistry.get(meta.runtime);
  } catch {
    // The recorded runtime is no longer registered. Treat as "no
    // events available" — dashboard renders NoEventsYet, the right
    // UX for an unrecoverable task.
    return null;
  }
  if (typeof runtime.readActivity !== "function") return null;
  return runtime.readActivity({
    runtimeSessionId,
    ...(opts?.before !== undefined ? { before: opts.before } : {}),
    ...(opts?.after !== undefined ? { after: opts.after } : {}),
    ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
  });
}

/**
 * Live-tail variant of {@link getTaskActivity}. Returns the
 * runtime's `streamActivity` AsyncIterable, or `null` when:
 *   - same null cases as `getTaskActivity` (missing task,
 *     unregistered runtime, no streaming support), OR
 *   - the task is already terminal (live tail has nothing more
 *     to deliver — caller should use the bounded
 *     `getTaskActivity` for post-mortem reads).
 *
 * The caller (SSE route) is responsible for closing the stream
 * when the HTTP client disconnects via `opts.signal`. The
 * runtime's iterator MUST honour the signal and clean up file
 * handles / watchers within a few hundred ms.
 */
export async function getTaskActivityStream(
  ctx: TaskServiceCtx,
  id: string,
  opts: { readonly after?: number; readonly signal?: AbortSignal },
): Promise<AsyncIterable<ActivityItem> | null> {
  assertValidTaskId(id);
  const task = await ctx.repository.read(id);
  if (task === null) return null;
  // Streaming a terminal task is wasted work — the iterator would
  // immediately yield nothing and close. Force callers to use the
  // one-shot endpoint for that case.
  if (task.status !== "running") return null;
  const meta = readTaskRuntimeMetadata(task);
  if (typeof meta.runtime !== "string") return null;
  const runtimeSessionId = pickRuntimeSessionId(task.metadata);
  if (runtimeSessionId === null) return null;
  let runtime: Runtime;
  try {
    runtime = ctx.runtimeRegistry.get(meta.runtime);
  } catch {
    return null;
  }
  if (typeof runtime.streamActivity !== "function") return null;
  return runtime.streamActivity({
    runtimeSessionId,
    ...(opts.after !== undefined ? { after: opts.after } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
}
