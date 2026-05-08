import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  AgentNotFoundError,
  InvalidTaskIdError,
  RuntimeDoesNotSupportTasksError,
  readTaskRuntimeMetadata,
  type Task,
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
  if (err instanceof InvalidTaskIdError) return 400;
  if (err instanceof TaskNotFoundError) return 404;
  if (err instanceof AgentNotFoundError) return 400;
  if (err instanceof RuntimeDoesNotSupportTasksError) return 400;
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
  app.delete("/:tid", async (c) => {
    const id = c.req.param("tid");
    try {
      await getManager(c).delete(id);
      return c.body(null, 204);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // Stream the runtime's events log for a task. The TaskManager junctions
  // the runtime's per-task state dir under `<workdir>/session/`, and the
  // canonical log inside is `events.jsonl`. We stream the file as-is —
  // each Copilot event is one line of JSON, so the dashboard parses
  // line-by-line.
  //
  // Returns:
  //   - 404 if the task doesn't exist (via TaskManager.get)
  //   - 404 with code=NoEventsYet if the junction or events.jsonl
  //     doesn't exist yet (e.g. agent hasn't written its first event,
  //     or junction install failed)
  //   - 200 text/plain otherwise
  app.get("/:tid/events", async (c) => {
    const id = c.req.param("tid");
    let task: Task | null;
    try {
      task = await getManager(c).get(id);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
    if (!task) return c.json({ error: "not found", code: "TaskNotFoundError" }, 404);

    const meta = readTaskRuntimeMetadata(task);
    const workdir = meta.workdir;
    if (typeof workdir !== "string") {
      return c.json({ error: "task has no workdir metadata", code: "NoEventsYet" }, 404);
    }
    const eventsPath = path.join(workdir, "session", "events.jsonl");
    try {
      await stat(eventsPath);
    } catch {
      return c.json(
        { error: "events.jsonl is not yet available for this task", code: "NoEventsYet" },
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
