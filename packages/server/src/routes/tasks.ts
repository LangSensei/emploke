import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { RuntimeDispatchTaskFailed } from "@emploke/runtime";
import {
  AgentNotFoundError,
  InvalidTaskIdError,
  RuntimeDoesNotSupportTasksError,
  TaskIdAllocationFailedError,
  type TaskManager,
  TaskNotFoundError,
} from "@emploke/task";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { errorBody, parseJsonBody } from "./_shared.js";

interface DispatchBody {
  agent?: unknown;
  instructions?: unknown;
  runtime?: unknown;
}

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

  // List every task in this workspace (newest-first per the manager).
  app.get("/", async (c) => {
    try {
      const list = await getManager(c).list();
      return c.json(list);
    } catch (err) {
      return c.json(errorBody(err), 400);
    }
  });

  // Dispatch a fresh task. Returns 201 + the running Task. The agent
  // continues to run in the background; clients poll `/:tid` (or watch
  // `/:tid/events`) for completion.
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<DispatchBody>(c);
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

  // Delete a task: kills the subprocess if live, then rm -rf the workdir.
  // `?force=1` skips the load-and-validate step and removes the directory
  // whenever it exists on disk — useful for cleaning up tasks whose
  // task.json is corrupted or schema-mismatched (e.g. across an emploke
  // upgrade). Without `force`, a corrupt task.json would leave the
  // directory undeletable through this endpoint (the dashboard would see
  // 404 even though the row appears in the list).
  app.delete("/:tid", async (c) => {
    const id = c.req.param("tid");
    const force = c.req.query("force") === "1";
    try {
      await getManager(c).delete(id, { force });
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

  return app;
}
