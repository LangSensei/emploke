import { RuntimeHeadlessLaunchFailed } from "@emploke/runtime";
import {
  AgentNotFoundError,
  CorruptedTaskError,
  EntryNotReadyError,
  InvalidTaskIdError,
  InvalidTransition,
  type ListTaskOpts,
  ManagerShuttingDownError,
  RuntimeDoesNotSupportTasksError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
  type TaskService,
  type TaskStatus,
} from "@emploke/task";
import { Hono } from "hono";
import { errorBody, logFault } from "./_shared.js";

/**
 * Resolver passed in by the mount point so route handlers pull the
 * workspace-scoped TaskService out of Hono's per-request context. Same
 * shape as `routes/tasks.ts:TaskServiceResolver`; the new route shares
 * the workspace-scoped `TaskService` instance so storage / dispatch /
 * cancel paths all observe a single in-memory state. See the mount in
 * `index.ts` — both routes pass `c.get("workspaceContext").tasks`.
 */
export type TaskServiceResolver = (c: import("hono").Context) => TaskService;

/**
 * Subset of `routes/tasks.ts:statusForError` that the list handler can
 * actually surface. The other handlers (dispatch, cancel, activity)
 * live exclusively on `/tasks/:tid`; the schedule route is read-only.
 *
 * Mirror, not import, so the two route files stay independently
 * understandable — adding a new error class only requires updating the
 * one route that throws it.
 */
function statusForError(err: unknown): number | null {
  if (err instanceof InvalidTaskIdError) return 400;
  if (err instanceof TaskNotFoundError) return 404;
  if (err instanceof AgentNotFoundError) return 400;
  if (err instanceof RuntimeDoesNotSupportTasksError) return 400;
  if (err instanceof EntryNotReadyError) return 409;
  if (err instanceof InvalidTransition) return 409;
  if (err instanceof ManagerShuttingDownError) return 503;
  if (err instanceof TaskIdAllocationFailedError) return 500;
  if (err instanceof RuntimeHeadlessLaunchFailed) return 500;
  if (err instanceof CorruptedTaskError) return 500;
  return null;
}

function resolveErrorStatus(err: unknown): { status: number; isUnmapped: boolean } {
  const mapped = statusForError(err);
  return { status: mapped ?? 400, isUnmapped: mapped === null };
}

function unmappedFaultMeta(err: unknown, extra?: Record<string, unknown>): Record<string, unknown> {
  const e = err instanceof Error ? err : undefined;
  return {
    name: e?.name,
    message: e?.message,
    ...(extra ?? {}),
  };
}

/**
 * Routes for `/api/workspaces/:wsId/scheduled-tasks`.
 *
 * Mounted at the parent in `index.ts`; paths here are relative to that
 * mount. This route is **schedule-origin-only by construction** — the
 * `origin` filter is hardcoded to `["schedule"]` and the route does not
 * expose an `?origin=` query param. Splitting at the URL layer (instead
 * of via a `?origin=` discriminator on `/tasks`) means each origin's
 * caller surface — dashboard, CLI, future MCP — gets a route whose URL
 * IS the contract; callers cannot accidentally widen the result set by
 * forgetting an opt-in filter.
 *
 * Polymorphic per-task surfaces (get-by-id, cancel, activity, events
 * SSE) stay on `/tasks/:tid` since task ids are globally unique and a
 * caller fetching a single task does not need to know the origin
 * up-front.
 */
export function scheduledTasksRoutes(resolveTaskService: TaskServiceResolver): Hono {
  const app = new Hono();
  const getManager = resolveTaskService;

  // List schedule-launched tasks in this workspace, newest-first per
  // the manager. The set is constrained to `origin = 'schedule'`
  // server-side; callers cannot widen.
  //
  // Optional server-side filters:
  //   ?scheduleId=<id>          — exact match on metadata.scheduleId
  //   ?agent=<name>             — exact match on Task.agent
  //   ?runtime=<kind>           — exact match on metadata.runtime
  //   ?createdSince=<iso8601>   — drop tasks older than the cutoff
  //   ?status=running,succeeded — include only listed statuses (CSV)
  app.get("/", async (c) => {
    const agent = c.req.query("agent");
    const runtime = c.req.query("runtime");
    const createdSince = c.req.query("createdSince");
    const status = c.req.query("status");
    const scheduleId = c.req.query("scheduleId");

    let createdSinceIso: string | undefined;
    if (createdSince !== undefined) {
      const t = Date.parse(createdSince);
      if (Number.isNaN(t)) {
        return c.json({ error: "createdSince must be an ISO 8601 timestamp" }, 400);
      }
      createdSinceIso = new Date(t).toISOString();
    }

    let statuses: TaskStatus[] | undefined;
    if (status !== undefined) {
      const valid = new Set<TaskStatus>(["running", "succeeded", "failed", "cancelled"]);
      const parts = status
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const bad = parts.find((s) => !valid.has(s as TaskStatus));
      if (bad !== undefined) {
        return c.json(
          {
            error: `unknown status: ${JSON.stringify(bad)} (expected running, succeeded, failed, cancelled)`,
          },
          400,
        );
      }
      statuses = parts as TaskStatus[];
    }

    const opts: { -readonly [K in keyof ListTaskOpts]: ListTaskOpts[K] } = {
      origin: ["schedule"],
    };
    if (agent !== undefined) opts.agent = agent;
    if (runtime !== undefined) opts.runtime = runtime;
    if (createdSinceIso !== undefined) opts.createdSince = createdSinceIso;
    if (statuses !== undefined) opts.statuses = statuses;
    if (scheduleId !== undefined) opts.scheduleId = scheduleId;

    try {
      const list = await getManager(c).list(opts);
      return c.json(list);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) {
        logFault(c, err, "scheduled-tasks.list: 5xx fault");
      } else if (isUnmapped) {
        logFault(
          c,
          err,
          "scheduled-tasks.list: unmapped error fell through to 400",
          unmappedFaultMeta(err),
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union; mirrors the same cast in routes/tasks.ts.
      return c.json(errorBody(err), status as any);
    }
  });

  return app;
}
