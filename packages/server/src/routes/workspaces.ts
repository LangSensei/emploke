import path from "node:path";
import {
  RegistryError,
  WorkspaceCorruptedError,
  WorkspaceError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  type WorkspaceManager,
  WorkspaceNameInvalidError,
  WorkspaceNotFoundError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
  type WorkspaceUpdatePatch,
} from "@emploke/workspace";
import type { Context } from "hono";
import { Hono } from "hono";
import type { WorkspaceContextCache } from "../workspace-context.js";
import { errorBody, parseJsonBody } from "./_shared.js";

/**
 * Build a JSON error response for a typed workspace error. Picks a
 * status via `workspaceErrorStatus`, falling back to `fallback`.
 *
 * The `as any` cast bridges Hono's literal-union of HTTP status codes
 * with our `number` return — every value `workspaceErrorStatus`
 * returns (and every fallback) is in {400,404,409,500}.
 */
function wsErrorJson(c: Context, err: unknown, fallback: number) {
  const status = workspaceErrorStatus(err) ?? fallback;
  // biome-ignore lint/suspicious/noExplicitAny: see helper docstring above
  return c.json(errorBody(err), status as any);
}

interface CreateBody {
  workdir?: unknown;
  name?: unknown;
  defaults?: unknown;
}

interface PutCurrentBody {
  /** UUID of the workspace to mark current. */
  id?: unknown;
}

interface PatchBody {
  name?: unknown;
  defaults?: unknown;
}

/**
 * Routes for `/api/workspaces/*`. Workspace-scoped resources (sessions,
 * tasks, catalog) live under `/api/workspaces/:id/...` and are mounted
 * separately so the workspace id is part of the resource URL.
 */
export function workspacesRoutes(deps: {
  manager: WorkspaceManager;
  cache: WorkspaceContextCache;
}): Hono {
  const app = new Hono();
  const { manager, cache } = deps;

  // List all registered workspaces.
  app.get("/", async (c) => {
    let workspaces: Awaited<ReturnType<WorkspaceManager["list"]>>;
    try {
      workspaces = await manager.list();
    } catch (err) {
      return wsErrorJson(c, err, 500);
    }
    return c.json(
      workspaces.map((ws) => ({
        id: ws.id,
        name: ws.name,
        createdAt: ws.createdAt,
        workdir: ws.workdir,
        ...(ws.defaults ? { defaults: ws.defaults } : {}),
      })),
    );
  });

  // Add a workspace: init the directory + register it. The id is
  // generated server-side. The display name is mandatory — there is no
  // auto-default and no basename fallback.
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<CreateBody>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (typeof body.workdir !== "string" || body.workdir.trim() === "") {
      return c.json({ error: "workdir is required (string)" }, 400);
    }
    if (typeof body.name !== "string") {
      return c.json({ error: "name is required (string)" }, 400);
    }
    if (
      body.defaults !== undefined &&
      (body.defaults === null || typeof body.defaults !== "object" || Array.isArray(body.defaults))
    ) {
      return c.json({ error: "defaults, when present, must be an object" }, 400);
    }

    const initOpts: {
      -readonly [K in keyof Parameters<WorkspaceManager["init"]>[0]]: Parameters<
        WorkspaceManager["init"]
      >[0][K];
    } = {
      name: body.name,
      workdir: path.resolve(body.workdir),
    };
    if (body.defaults && typeof body.defaults === "object") {
      initOpts.defaults = body.defaults as Parameters<WorkspaceManager["init"]>[0]["defaults"];
    }

    try {
      const ws = await manager.init(initOpts);
      return c.json(
        {
          id: ws.id,
          name: ws.name,
          createdAt: ws.createdAt,
          workdir: ws.workdir,
          ...(ws.defaults ? { defaults: ws.defaults } : {}),
        },
        201,
      );
    } catch (err) {
      return wsErrorJson(c, err, 400);
    }
  });

  // Read the currently-selected workspace id.
  app.get("/current", async (c) => {
    try {
      const id = await manager.getCurrent();
      return c.json({ id });
    } catch (err) {
      return wsErrorJson(c, err, 500);
    }
  });

  // Set the currently-selected workspace by id.
  app.put("/current", async (c) => {
    const parsed = await parseJsonBody<PutCurrentBody>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (typeof parsed.body.id !== "string" || parsed.body.id === "") {
      return c.json({ error: "id is required (string)" }, 400);
    }
    try {
      await manager.setCurrent(parsed.body.id);
    } catch (err) {
      return wsErrorJson(c, err, 400);
    }
    return c.json({ id: parsed.body.id });
  });

  // Get a single workspace.
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    let ws: Awaited<ReturnType<WorkspaceManager["read"]>>;
    try {
      ws = await manager.read(id);
    } catch (err) {
      return wsErrorJson(c, err, 500);
    }
    if (!ws) {
      return c.json(
        { error: "workspace not registered", code: "WorkspaceNotRegisteredError" },
        404,
      );
    }
    return c.json({
      id: ws.id,
      name: ws.name,
      createdAt: ws.createdAt,
      workdir: ws.workdir,
      ...(ws.defaults ? { defaults: ws.defaults } : {}),
    });
  });

  // Update a workspace's mutable fields (name, defaults).
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = await parseJsonBody<PatchBody>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;

    const patch: { -readonly [K in keyof WorkspaceUpdatePatch]: WorkspaceUpdatePatch[K] } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string") {
        return c.json({ error: "name, when present, must be a string" }, 400);
      }
      patch.name = body.name;
    }
    if (body.defaults !== undefined) {
      if (body.defaults === null) {
        patch.defaults = null;
      } else if (typeof body.defaults !== "object" || Array.isArray(body.defaults)) {
        return c.json({ error: "defaults, when present, must be an object or null" }, 400);
      } else {
        patch.defaults = body.defaults as WorkspaceUpdatePatch["defaults"];
      }
    }
    if (patch.name === undefined && patch.defaults === undefined) {
      return c.json({ error: "patch must include at least one of: name, defaults" }, 400);
    }

    try {
      const updated = await manager.update(id, patch);
      cache.invalidate(id);
      return c.json({
        id: updated.id,
        name: updated.name,
        createdAt: updated.createdAt,
        workdir: updated.workdir,
        ...(updated.defaults ? { defaults: updated.defaults } : {}),
      });
    } catch (err) {
      return wsErrorJson(c, err, 500);
    }
  });

  // Remove a workspace. Default behaviour removes only the metadata
  // (workspace.json + index entry); user files preserved. Pass
  // `?purge=1` to also rm every emploke-owned subdirectory under the
  // workspace's workdir (sessions/, tasks/, catalog/, workflows/,
  // logs/). The workdir itself is never removed.
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const purge = c.req.query("purge") === "1";
    try {
      await manager.delete(id, { purge });
    } catch (err) {
      return wsErrorJson(c, err, 400);
    }
    cache.invalidate(id);
    return c.body(null, 204);
  });

  return app;
}

/**
 * Map workspace errors to HTTP status codes. Generic 5xx for
 * unrecognised errors; the body is sanitised by `errorBody` so
 * internals never leak.
 */
function workspaceErrorStatus(err: unknown): number | null {
  if (err instanceof WorkspaceNameInvalidError) return 400;
  if (err instanceof WorkspaceIdInvalidError) return 400;
  if (err instanceof WorkspaceNotRegisteredError) return 404;
  if (err instanceof WorkspaceNotFoundError) return 404;
  if (err instanceof WorkspaceIdConflictError) return 409;
  if (err instanceof WorkspacePathConflictError) return 409;
  if (err instanceof WorkspaceCorruptedError) return 500;
  if (err instanceof RegistryError) return 500;
  if (err instanceof WorkspaceError) return 500;
  return null;
}
