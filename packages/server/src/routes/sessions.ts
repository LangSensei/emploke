import {
  AgentNotFoundError,
  CopilotSessionNotFoundError,
  CopilotStateDeletionFailed,
  InvalidCopilotSessionIdError,
  InvalidSessionIdError,
  type SessionManager,
  SessionNotFoundError,
} from "@emploke/session";
import { Hono } from "hono";

interface CreateBody {
  agent?: unknown;
}

/**
 * Map sessions errors to HTTP status codes. Returns null for unknown errors
 * so the caller can use a default (400 with the message).
 */
function statusForError(err: unknown): number | null {
  if (err instanceof InvalidSessionIdError) return 400;
  if (err instanceof InvalidCopilotSessionIdError) return 400;
  if (err instanceof CopilotSessionNotFoundError) return 404;
  if (err instanceof SessionNotFoundError) return 404;
  if (err instanceof AgentNotFoundError) return 400;
  if (err instanceof CopilotStateDeletionFailed) return 409;
  return null;
}

function errorBody(err: unknown): { error: string; code?: string } {
  const error = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name) return { error, code: err.name };
  return { error };
}

/**
 * Routes for /api/sessions/*. The Hono `app.route("/api/sessions", ...)`
 * call in index.ts strips the `/api/sessions` prefix, so paths here are
 * relative ("/", "/:id", etc.).
 */
export function sessionsRoutes(manager: SessionManager): Hono {
  const r = new Hono();

  // List sessions, optionally filtered by agent.
  r.get("/", async (c) => {
    const agent = c.req.query("agent");
    try {
      const list = await manager.list(agent !== undefined ? { agent } : {});
      return c.json(list);
    } catch (err) {
      return c.json(errorBody(err), 400);
    }
  });

  // Create a new session for the given agent.
  r.post("/", async (c) => {
    let body: CreateBody;
    try {
      body = (await c.req.json()) as CreateBody;
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }
    if (typeof body.agent !== "string" || body.agent.trim() === "") {
      return c.json({ error: "agent is required (string)" }, 400);
    }
    try {
      const rec = await manager.create({ agent: body.agent });
      return c.json(rec, 201);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union.
      return c.json(errorBody(err), status as any);
    }
  });

  // Get a single session by id.
  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const rec = await manager.get(id);
      if (!rec) return c.json({ error: "not found", code: "SessionNotFoundError" }, 404);
      return c.json(rec);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // Delete a session.
  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const deleteCopilotState = c.req.query("deleteCopilotState") === "1";
    try {
      await manager.delete(id, { deleteCopilotState });
      return c.body(null, 204);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // Return the launch incantation for the session.
  r.get("/:id/launch-command", async (c) => {
    const id = c.req.param("id");
    try {
      const cmd = await manager.getLaunchCommand(id);
      return c.json(cmd);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // Return the resume incantation for a specific Copilot session id.
  r.get("/:id/resume-command/:copilotSessionId", async (c) => {
    const id = c.req.param("id");
    const sid = c.req.param("copilotSessionId");
    try {
      const cmd = await manager.getResumeCommand(id, sid);
      return c.json(cmd);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  return r;
}
