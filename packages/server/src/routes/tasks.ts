import { RuntimeDispatchTaskFailed } from "@emploke/runtime";
import {
  AgentNotFoundError,
  EntryNotReadyError,
  InvalidTaskIdError,
  type ListTaskOpts,
  RuntimeDoesNotSupportTasksError,
  TaskIdAllocationFailedError,
  type TaskManager,
  TaskNotFoundError,
  type TaskStatus,
} from "@emploke/task";
import { Hono } from "hono";
import { errorBody, logServerError, parseJsonBody } from "./_shared.js";
import type { TaskDispatchBody } from "./manifest.js";

/**
 * Defensive parse alias for the dispatch body. See `sessions.ts` for
 * the rationale — the manifest type is the wire contract for callers,
 * the *Raw alias keeps runtime guards TS-meaningful.
 */
type TaskDispatchBodyRaw = { [K in keyof TaskDispatchBody]?: unknown };

/**
 * Resolver passed in by the mount point so route handlers pull the
 * workspace-scoped TaskManager out of Hono's per-request context. Mirrors
 * the SessionManager pattern exactly.
 */
export type TaskManagerResolver = (c: import("hono").Context) => TaskManager;

function statusForError(err: unknown): number | null {
  // Client-side / input errors → 4xx.
  if (err instanceof InvalidTaskIdError) return 400;
  if (err instanceof TaskNotFoundError) return 404;
  if (err instanceof AgentNotFoundError) return 400;
  if (err instanceof RuntimeDoesNotSupportTasksError) return 400;
  // The agent (or one of its transitive deps) is currently `blocked`
  // — caller-fixable state conflict (acknowledge prereqs, enable the
  // agent, install the missing dep, etc.). 409 mirrors how
  // `HasDependentsError` is mapped on the catalog side.
  if (err instanceof EntryNotReadyError) return 409;
  // Server-side / host faults → 5xx. These match the analogous
  // mappings in sessions.ts (SessionIdAllocationFailedError → 500,
  // RuntimeProvisionFailed → 500). Falling through to the default 400
  // would lie to the dashboard about whose fault it is.
  if (err instanceof TaskIdAllocationFailedError) return 500;
  if (err instanceof RuntimeDispatchTaskFailed) return 500;
  return null;
}

/**
 * Routes for `/api/workspaces/:wsId/tasks/*`.
 *
 * Mounted at the parent in `index.ts`; paths here are relative to that
 * mount. Same shape as `sessionsRoutes` — accept either a resolver or a
 * bare manager (the latter is the test idiom).
 */
export function tasksRoutes(resolveManager: TaskManagerResolver | TaskManager): Hono {
  const app = new Hono();
  const getManager: TaskManagerResolver =
    typeof resolveManager === "function"
      ? (resolveManager as TaskManagerResolver)
      : () => resolveManager;

  // List tasks in this workspace, newest-first per the manager.
  // Optional server-side filters (mirroring the sessions route):
  //   ?agent=<name>             — exact match on Task.agent
  //   ?runtime=<kind>           — exact match on metadata.runtime
  //   ?createdSince=<iso8601>   — drop tasks older than the cutoff
  //   ?status=running,success   — include only listed statuses (CSV)
  // Pushing filters to the server keeps the wire payload + dashboard
  // re-render bounded for workspaces with hundreds of tasks. Filters
  // not present in the query are passed through unset.
  app.get("/", async (c) => {
    const agent = c.req.query("agent");
    const runtime = c.req.query("runtime");
    const createdSince = c.req.query("createdSince");
    const status = c.req.query("status");

    // Same canonicalisation discipline sessions.ts uses: parse leniently
    // (`Date.parse` accepts loose forms), then forward the canonical
    // ISO 8601 string so the manager's lexicographic compare stays
    // correct.
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
      const valid = new Set<TaskStatus>([
        "not_started",
        "running",
        "success",
        "failure",
        "cancelled",
      ]);
      const parts = status
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const bad = parts.find((s) => !valid.has(s as TaskStatus));
      if (bad !== undefined) {
        return c.json(
          {
            error: `unknown status: ${JSON.stringify(bad)} (expected not_started, running, success, failure, cancelled)`,
          },
          400,
        );
      }
      statuses = parts as TaskStatus[];
    }

    // Build the opts shape mutably; ListTaskOpts itself is `readonly`
    // by convention so the manager can safely capture it.
    const opts: { -readonly [K in keyof ListTaskOpts]: ListTaskOpts[K] } = {};
    if (agent !== undefined) opts.agent = agent;
    if (runtime !== undefined) opts.runtime = runtime;
    if (createdSinceIso !== undefined) opts.createdSince = createdSinceIso;
    if (statuses !== undefined) opts.statuses = statuses;

    try {
      const list = await getManager(c).list(opts);
      return c.json(list);
    } catch (err) {
      return c.json(errorBody(err), 400);
    }
  });

  // Dispatch a fresh task. Returns 201 + the running Task. The agent
  // continues to run in the background; clients poll `/:tid` (or watch
  // `/:tid/events`) for completion.
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<TaskDispatchBodyRaw>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (typeof body.agent !== "string" || body.agent.trim() === "") {
      return c.json({ error: "agent is required (string)" }, 400);
    }
    if (typeof body.instructions !== "string" || body.instructions.trim() === "") {
      return c.json({ error: "instructions is required (string)" }, 400);
    }
    if (body.runtime !== undefined && typeof body.runtime !== "string") {
      return c.json({ error: "runtime, when present, must be a string" }, 400);
    }
    try {
      const task = await getManager(c).dispatch({
        agent: body.agent,
        instructions: body.instructions,
        ...(typeof body.runtime === "string" ? { runtime: body.runtime } : {}),
      });
      return c.json(task, 201);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      if (status >= 500) logServerError(err);
      // EntryNotReadyError carries a structured `BlockedReason` on
      // the instance; surface it on the wire so the dashboard can
      // render typed UI (the catalog list already uses the same
      // `blockedReason` shape — see CatalogManager.getAgentEntry).
      // Without this branch the body collapses to `{error, code}`
      // and the dashboard would be stuck parsing a human string to
      // figure out which CTA (Acknowledge prereqs / Enable agent /
      // Install missing dep) applies.
      if (err instanceof EntryNotReadyError) {
        return c.json(
          {
            error: err.message,
            code: err.name,
            agent: err.agent,
            ...(err.reason !== undefined ? { reason: err.reason } : {}),
          },
          // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union.
          status as any,
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union.
      return c.json(errorBody(err), status as any);
    }
  });

  // Get a single task by id.
  app.get("/:tid", async (c) => {
    const id = c.req.param("tid");
    try {
      const task = await getManager(c).get(id);
      if (!task) return c.json({ error: "not found", code: "TaskNotFoundError" }, 404);
      return c.json(task);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // Delete a task. Default ("archive") removes only the task's metadata
  // row; the workdir contents (stderr.log, agent-produced files) and
  // the runtime's per-task event log stay on disk so the user can
  // inspect the run after the fact. Pass `?purge=1` for the hard-
  // delete path: row + workdir + runtime state, in that order
  // (runtime first so a runtime-side failure aborts before any local
  // removal — mirrors session-delete semantics). `purge=1` also
  // skips metadata validation, mirroring `rm -rf` for cleanup of
  // tasks whose row is corrupted or schema-mismatched across an
  // emploke upgrade.
  app.delete("/:tid", async (c) => {
    const id = c.req.param("tid");
    const purge = c.req.query("purge") === "1";
    try {
      await getManager(c).delete(id, { purge });
      return c.body(null, 204);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // Runtime-neutral activity timeline for a task. The runtime
  // end-to-end owns reading + parsing its own event log into the
  // {ActivityItem, TaskActivityResult} vocabulary; this route just
  // forwards that result as JSON.
  //
  // Pagination via `?cursor=<seq>&limit=<n>`. The route enforces
  // limit in [1, 500], default 50 — sized for LLM token budgets so
  // this surface stays MCP-safe by construction. Both params are
  // optional; omitting cursor returns the head, omitting limit
  // applies the 50 default.
  //
  // Returns:
  //   - 400 on malformed cursor / limit (non-integer, negative, > max)
  //   - 404 if the task doesn't exist
  //   - 404 with code=NoEventsYet if the runtime doesn't implement
  //     `taskActivity`, or has no log for this task yet
  //   - 200 application/json `{ activity, result, cursor, totalItems?, truncated? }`
  app.get("/:tid/activity", async (c) => {
    const id = c.req.param("tid");
    const cursorRaw = c.req.query("cursor");
    const limitRaw = c.req.query("limit");

    let cursor: number | undefined;
    if (cursorRaw !== undefined) {
      const parsed = Number.parseInt(cursorRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || `${parsed}` !== cursorRaw) {
        return c.json({ error: "cursor must be a non-negative integer", code: "BadRequest" }, 400);
      }
      cursor = parsed;
    }

    let limit: number = TASK_ACTIVITY_DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > TASK_ACTIVITY_MAX_LIMIT) {
        return c.json(
          {
            error: `limit must be an integer in [1, ${TASK_ACTIVITY_MAX_LIMIT}]`,
            code: "BadRequest",
          },
          400,
        );
      }
      limit = parsed;
    }

    let payload: Awaited<ReturnType<TaskManager["getTaskActivity"]>>;
    try {
      payload = await getManager(c).getTaskActivity(id, {
        ...(cursor !== undefined ? { cursor } : {}),
        limit,
      });
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
    if (payload === null) {
      return c.json({ error: "no activity is available for this task", code: "NoEventsYet" }, 404);
    }
    return c.json(payload);
  });

  // SSE live tail. Subscribes to runtime.taskActivityStream and
  // pushes each ActivityItem as `event: activity` with the JSON
  // payload. Sends `event: end` on iterator completion, `event: error`
  // on faults. Standard SSE wire format — any HTTP client can
  // consume (curl -N, EventSource, eventsource-parser).
  //
  // The SSE iterator is cancelled when the HTTP client disconnects
  // (request `signal` propagates to the runtime via TaskManager).
  // This route is HUMAN-only: not exposed via MCP because LLM tool
  // surfaces require bounded responses, not streams.
  //
  // Returns:
  //   - 404 if the task doesn't exist
  //   - 404 with code=NoEventsYet if the runtime doesn't implement
  //     streaming
  //   - 200 text/event-stream otherwise (long-lived response)
  app.get("/:tid/activity/stream", async (c) => {
    const id = c.req.param("tid");
    let stream: AsyncIterable<import("@emploke/runtime").ActivityItem> | null;
    try {
      const lastEventId = c.req.header("Last-Event-ID");
      const cursor =
        lastEventId !== undefined && /^\d+$/.test(lastEventId)
          ? Number.parseInt(lastEventId, 10)
          : undefined;
      stream = await getManager(c).getTaskActivityStream(id, {
        ...(cursor !== undefined ? { cursor } : {}),
        signal: c.req.raw.signal,
      });
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
    if (stream === null) {
      return c.json(
        { error: "no streaming activity available for this task", code: "NoEventsYet" },
        404,
      );
    }

    // Hono SSE: hand back a Response with a ReadableStream framed
    // per the EventSource spec.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enqueue = (frame: string) => {
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            // Controller closed (client gone).
          }
        };
        try {
          for await (const item of stream as AsyncIterable<
            import("@emploke/runtime").ActivityItem
          >) {
            if (c.req.raw.signal.aborted) break;
            enqueue(`event: activity\nid: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`);
          }
          enqueue("event: end\ndata: {}\n\n");
        } catch (err) {
          enqueue(
            `event: error\ndata: ${JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            })}\n\n`,
          );
        } finally {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Disable Nginx buffering that would defeat the live-tail UX.
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}

/** Default `limit` for `GET /tasks/:tid/activity` when caller omits it. Sized for LLM token budgets. */
const TASK_ACTIVITY_DEFAULT_LIMIT = 50;
/** Hard maximum `limit` accepted from callers. Defends the dashboard / MCP from blowing memory. */
const TASK_ACTIVITY_MAX_LIMIT = 500;
