import type { LaunchCommand } from "@emploke/runtime";
import {
  AgentNotFoundError,
  InvalidSessionIdError,
  RuntimeProvisionFailed,
  RuntimeStateDeletionFailed,
  SessionIdAllocationFailedError,
  type SessionManager,
  SessionNotFoundError,
  UnknownRuntimeError,
} from "@emploke/session";
import {
  NoTerminalFoundError,
  type SpawnTerminalResult,
  spawnTerminal,
  TerminalSpawnFailedError,
  UnsupportedPlatformError,
} from "@emploke/terminal";
import { Hono } from "hono";
import { errorBody, parseJsonBody } from "./_shared.js";

interface CreateBody {
  agent?: unknown;
  runtime?: unknown;
}

/** Override hook used by tests to bypass real terminal spawning. */
export type SpawnFn = (cmd: LaunchCommand) => Promise<SpawnTerminalResult>;

/**
 * Map sessions errors to HTTP status codes. Returns null for unknown errors
 * so the caller can use a default (400 with the message).
 */
function statusForError(err: unknown): number | null {
  if (err instanceof InvalidSessionIdError) return 400;
  if (err instanceof SessionNotFoundError) return 404;
  if (err instanceof AgentNotFoundError) return 400;
  if (err instanceof UnknownRuntimeError) return 400;
  if (err instanceof RuntimeStateDeletionFailed) return 409;
  if (err instanceof SessionIdAllocationFailedError) return 500;
  // Provisioning failures (git init, MCP/skill copy, agent file resolution)
  // are server-side faults — the client's request was well-formed; the host
  // environment broke. 500 lets clients distinguish from 4xx user errors.
  if (err instanceof RuntimeProvisionFailed) return 500;
  return null;
}

/**
 * Routes for /api/sessions/*. The Hono `app.route("/api/sessions", ...)`
 * call in index.ts strips the `/api/sessions` prefix, so paths here are
 * relative ("/", "/:id", etc.).
 *
 * `spawnFn` is injected so tests can stub the terminal launch without
 * touching the host. Production passes the default `spawnTerminal`.
 */
export function sessionsRoutes(manager: SessionManager, spawnFn: SpawnFn = spawnTerminal): Hono {
  const app = new Hono();

  // List sessions, optionally filtered by agent and/or createdSince timestamp.
  app.get("/", async (c) => {
    const agent = c.req.query("agent");
    const createdSince = c.req.query("createdSince");
    // The manager compares createdSince against draft.createdAt with a plain
    // string `<` (which is correct for ISO 8601 with a `Z` suffix because
    // those strings sort lexicographically as dates). If we accepted any
    // Date.parse-able form like "Jan 1 2024" and forwarded it raw, the
    // lexicographic compare would be wrong (e.g. '2' < 'J' makes a 2026
    // session sort below a "Jan 1 2024" cutoff). So: parse leniently,
    // then forward the canonical ISO 8601 form.
    let createdSinceIso: string | undefined;
    if (createdSince !== undefined) {
      const t = Date.parse(createdSince);
      if (Number.isNaN(t)) {
        return c.json({ error: "createdSince must be an ISO 8601 timestamp" }, 400);
      }
      createdSinceIso = new Date(t).toISOString();
    }
    const opts: { agent?: string; createdSince?: string } = {};
    if (agent !== undefined) opts.agent = agent;
    if (createdSinceIso !== undefined) opts.createdSince = createdSinceIso;
    try {
      const list = await manager.list(opts);
      return c.json(list);
    } catch (err) {
      return c.json(errorBody(err), 400);
    }
  });

  // Create a new session for the given agent.
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<CreateBody>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (typeof body.agent !== "string" || body.agent.trim() === "") {
      return c.json({ error: "agent is required (string)" }, 400);
    }
    if (body.runtime !== undefined && typeof body.runtime !== "string") {
      return c.json({ error: "runtime, when present, must be a string" }, 400);
    }
    try {
      const rec = await manager.create({
        agent: body.agent,
        ...(typeof body.runtime === "string" ? { runtime: body.runtime } : {}),
      });
      return c.json(rec, 201);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union.
      return c.json(errorBody(err), status as any);
    }
  });

  // Get a single session by id.
  app.get("/:id", async (c) => {
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
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const deleteRuntimeState = c.req.query("deleteRuntimeState") === "1";
    try {
      await manager.delete(id, { deleteRuntimeState });
      return c.body(null, 204);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // One-click launch: build the launch command via the runtime adapter and
  // hand it to the terminal spawner. On any spawn failure we return 200
  // with `{ ok: false, display, ... }` so the dashboard can fall back to
  // showing the copy-paste command without needing a second round-trip.
  app.post("/:id/spawn", async (c) => {
    const id = c.req.param("id");

    let cmd: LaunchCommand;
    try {
      cmd = await manager.buildLaunch(id);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }

    try {
      const result = await spawnFn(cmd);
      return c.json({ ok: true as const, launcher: result.launcher, display: cmd.display });
    } catch (err) {
      const code = spawnErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({
        ok: false as const,
        error: message,
        code,
        display: cmd.display,
      });
    }
  });

  return app;
}

function spawnErrorCode(err: unknown): string {
  if (err instanceof NoTerminalFoundError) return "NoTerminalFoundError";
  if (err instanceof TerminalSpawnFailedError) return "TerminalSpawnFailedError";
  if (err instanceof UnsupportedPlatformError) return "UnsupportedPlatformError";
  if (err instanceof Error && err.name) return err.name;
  return "SpawnError";
}
