import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { RuntimeDispatchTaskFailed } from "@emploke/runtime";
import {
  AgentNotFoundError,
  InvalidTaskIdError,
  type ListTaskOpts,
  RuntimeDoesNotSupportTasksError,
  TaskIdAllocationFailedError,
  type TaskManager,
  TaskNotFoundError,
  type TaskStatus,
} from "@emploke/task";
import { Hono } from "hono";
import { stream } from "hono/streaming";
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

  // Delete a task. Default behaviour removes only the task's metadata
  // (the repository row / task.json); the workdir contents — including
  // the runtime's session junction and any agent-produced files — are
  // preserved for archival. Pass `?purge=1` to additionally rm the
  // entire workdir AND skip metadata validation (mirrors `rm -rf`,
  // useful for cleaning up tasks whose task.json is corrupted or
  // schema-mismatched across an emploke upgrade).
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

  // Stream the runtime's events log for a task. The path is resolved
  // by the runtime via `Runtime.taskEventsPath` (looked up through
  // `TaskManager.getTaskEventsPath` so this route doesn't depend on
  // `@emploke/runtime` directly), so each runtime is free to put its
  // log wherever and call it whatever it wants. We still treat the
  // file's contents as opaque bytes here — clients parse per-runtime
  // (today the Copilot adapter writes NDJSON; future runtimes may
  // differ). The Content-Type stays `application/x-ndjson` because
  // that's the only format the dashboard knows how to render right now;
  // a typed cross-runtime event stream is tracked separately.
  //
  // Returns:
  //   - 404 if the task doesn't exist
  //   - 404 with code=NoEventsYet if the runtime has no event log,
  //     hasn't created it yet, or doesn't implement the optional
  //     `taskEventsPath` surface
  //   - 200 application/x-ndjson otherwise
  app.get("/:tid/events", async (c) => {
    const id = c.req.param("tid");
    let eventsPath: string | null;
    try {
      eventsPath = await getManager(c).getTaskEventsPath(id);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
    if (eventsPath === null) {
      // Either the task is missing or the runtime declined to provide a
      // path. The dashboard surfaces both as the same NoEventsYet state;
      // the explicit 404 for a genuinely-missing task is left to GET /:tid.
      return c.json({ error: "no event log is available for this task", code: "NoEventsYet" }, 404);
    }
    try {
      await stat(eventsPath);
    } catch {
      return c.json(
        { error: "event log file is not yet present on disk", code: "NoEventsYet" },
        404,
      );
    }

    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return stream(c, async (s) => {
      const rs = createReadStream(eventsPath, { encoding: "utf8" });
      try {
        for await (const chunk of rs) {
          await s.write(chunk as string);
        }
      } finally {
        rs.close();
      }
    });
  });

  // Runtime-neutral activity timeline for a task. The runtime parses
  // its own event log into the {ActivityItem, ActivitySummary} vocabulary
  // declared in @emploke/runtime; this route just forwards that result
  // as JSON. Consumers (dashboard, future MCP clients) render without
  // knowing which runtime produced the underlying log.
  //
  // Returns:
  //   - 404 if the task doesn't exist
  //   - 404 with code=NoEventsYet if the runtime doesn't implement
  //     parseActivity, or the log file isn't on disk yet
  //   - 200 application/json `{ activity: ActivityItem[], result: string|null }` otherwise
  app.get("/:tid/activity", async (c) => {
    const id = c.req.param("tid");
    let payload: Awaited<ReturnType<TaskManager["getTaskActivity"]>>;
    try {
      payload = await getManager(c).getTaskActivity(id);
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

  return app;
}
