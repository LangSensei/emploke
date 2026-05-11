import { randomUUID } from "node:crypto";
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
import { type WorkspaceContextCache, WorkspaceHasLiveTasksError } from "../workspace-context.js";
import { errorBody, logServerError, parseJsonBody } from "./_shared.js";
import type {
  WorkspaceCreateBody,
  WorkspaceCurrentPutBody,
  WorkspacePatchBody,
} from "./manifest.js";

/**
 * Build a JSON error response for a typed workspace error. Picks a
 * status via `workspaceErrorStatus`, falling back to `fallback`.
 *
 * Server-side errors (status >= 500) are logged to stderr at the boundary
 * so operators get the full diagnostic before the body is sanitised for
 * the client. Same contract as the runtime error path in sessions.ts /
 * tasks.ts (#24) — every 5xx that escapes a route handler must be
 * observable in logs.
 *
 * The `as any` cast bridges Hono's literal-union of HTTP status codes
 * with our `number` return — every value `workspaceErrorStatus`
 * returns (and every fallback) is in {400,404,409,500}.
 */
function wsErrorJson(c: Context, err: unknown, fallback: number) {
  const status = workspaceErrorStatus(err) ?? fallback;
  if (status >= 500) {
    logServerError(err);
  }
  // biome-ignore lint/suspicious/noExplicitAny: see helper docstring above
  return c.json(errorBody(err), status as any);
}

/**
 * Defensive parse aliases — the manifest types are the strict wire
 * contract, but we still validate every field at runtime because the
 * JSON we get on the wire is `unknown` regardless of TypeScript's
 * declared shape. Locally re-typing the parsed body as a partial /
 * `unknown`-fielded variant lets the existing typeof / Array.isArray
 * guards stay both defensive and unsuppressed by TS narrowing.
 */
type CreateBodyRaw = { [K in keyof WorkspaceCreateBody]?: unknown };
type PutCurrentBodyRaw = { [K in keyof WorkspaceCurrentPutBody]?: unknown };
type PatchBodyRaw = { [K in keyof WorkspacePatchBody]?: unknown };

/**
 * Routes for `/api/workspaces/*`. Workspace-scoped resources (sessions,
 * tasks, catalog) live under `/api/workspaces/:id/...` and are mounted
 * separately so the workspace id is part of the resource URL.
 *
 * `defaultWorkspaceParent` is the directory under which auto-generated
 * workspace directories are created when the user creates a workspace
 * without specifying a `workdir`. Server bootstrap passes
 * `<EMPLOKE_HOME>/workspaces`; the route mints a fresh UUID-named
 * directory under it per such request.
 */
export function workspacesRoutes(deps: {
  manager: WorkspaceManager;
  cache: WorkspaceContextCache;
  defaultWorkspaceParent: string;
}): Hono {
  const app = new Hono();
  const { manager, cache, defaultWorkspaceParent } = deps;

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
  // generated server-side. The display name is mandatory; `workdir` is
  // optional — when omitted, the server generates a fresh
  // `<defaultWorkspaceParent>/<uuid>/` directory and uses that. The
  // generated dir name is intentionally a UUID (not the display name)
  // so renames stay free and two workspaces with the same display name
  // don't collide on disk.
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<CreateBodyRaw>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (typeof body.name !== "string") {
      return c.json({ error: "name is required (string)" }, 400);
    }
    let workdir: string;
    let preallocatedId: string | undefined;
    if (body.workdir === undefined || body.workdir === null || body.workdir === "") {
      // Auto-generate. Mint the workspace id here and reuse it as the
      // on-disk dir name so the registry id and the directory basename
      // stay coupled — `ls $EMPLOKE_HOME/workspaces/` reads as "list
      // workspace ids" and the dashboard URL `<wsId>` matches the path
      // on disk. We don't mkdir here — `WorkspaceManager.init` does
      // that idempotently.
      preallocatedId = randomUUID();
      workdir = path.join(defaultWorkspaceParent, preallocatedId);
    } else if (typeof body.workdir !== "string" || body.workdir.trim() === "") {
      return c.json({ error: "workdir, when present, must be a non-empty string" }, 400);
    } else {
      workdir = path.resolve(body.workdir);
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
      workdir,
    };
    if (preallocatedId !== undefined) initOpts.id = preallocatedId;
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
    const parsed = await parseJsonBody<PutCurrentBodyRaw>(c);
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
    const parsed = await parseJsonBody<PatchBodyRaw>(c);
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

  // Force the cached `WorkspaceContext` for this id to be rebuilt on the
  // next request. Use case: catalog drift — the user added an agent yaml
  // to `<workspace>/catalog/agents/` from outside emploke (manual edit,
  // git pull, …) and the cached `CatalogManager` snapshot is stale.
  //
  // Returns:
  //   - 204 on success (the fresh context is also pre-loaded so the next
  //     request hits cache).
  //   - 404 if the workspace is no longer registered.
  //   - 409 with `code=WorkspaceHasLiveTasksError` when there are live
  //     task subprocesses; reloading would orphan them and race the
  //     fresh `recoverOrphaned` sweep. Caller cancels the tasks (or
  //     waits) and retries.
  //   - 500 for any other load failure (e.g. corrupted workspace.json),
  //     surfaced as `errorBody(err)` so the dashboard can show why.
  app.post("/:id/reload", async (c) => {
    const id = c.req.param("id");
    try {
      const ctx = await cache.reload(id);
      if (!ctx) {
        return c.json(
          { error: "workspace not registered", code: "WorkspaceNotRegisteredError" },
          404,
        );
      }
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof WorkspaceHasLiveTasksError) {
        return c.json(errorBody(err), 409);
      }
      // Reload failures past the live-task gate are 5xx — the workspace
      // exists but couldn't be rebuilt (corrupted on-disk state, fs
      // permissions, …). The 5xx logging happens inside `wsErrorJson`
      // (#24).
      return wsErrorJson(c, err, 500);
    }
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
