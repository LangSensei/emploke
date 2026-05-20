import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  RegisterWorkspaceCommand,
  RegistryError,
  RenameWorkspaceCommand,
  SetCurrentWorkspaceCommand,
  UnregisterWorkspaceCommand,
  WorkspaceCorruptedError,
  WorkspaceError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNameInvalidError,
  WorkspaceNotFoundError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
  type WorkspaceQueries,
} from "@emploke/workspace";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Mediator } from "mediatr-ts";
import {
  type PerWorkspaceContainerCache,
  WorkspaceHasLiveTasksError,
} from "../per-workspace-container.js";
import { errorBody, logEvent, logFault, parseJsonBody } from "./_shared.js";
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
    logFault(c, err, "workspaces: 5xx fault");
  }
  // biome-ignore lint/suspicious/noExplicitAny: see helper docstring above
  return c.json(errorBody(err), status as any);
}

/**
 * Defensive parse aliases — the manifest types are the strict wire
 * contract, but we still validate every field at runtime because the
 * JSON we get on the wire is `unknown` regardless of TypeScript's
 * declared shape.
 */
type CreateBodyRaw = { [K in keyof WorkspaceCreateBody]?: unknown };
type PutCurrentBodyRaw = { [K in keyof WorkspaceCurrentPutBody]?: unknown };
type PatchBodyRaw = { [K in keyof WorkspacePatchBody]?: unknown };

/**
 * Routes for `/api/workspaces/*`. Workspace-scoped resources (sessions,
 * tasks, catalog) live under `/api/workspaces/:id/...` and are mounted
 * separately so the workspace id is part of the resource URL.
 *
 * Post-Phase-1 of issue #135, this layer is a thin transport adapter:
 * write endpoints dispatch `mediator.send(new XxxCommand(...))` and
 * read endpoints call `queries.list()` / `.getById()` / `.getCurrent()`.
 * The wire shape (request body, response body, status codes) is
 * IDENTICAL to the pre-refactor implementation that wrapped
 * `WorkspaceManager` — `WorkspaceManager` is gone but every existing
 * client (dashboard, CLI, MCP) sees the same surface.
 *
 * `defaultWorkspaceParent` is the directory under which auto-generated
 * workspace directories are created when the user creates a workspace
 * without specifying a `workspaceDir`. Server bootstrap passes
 * `<EMPLOKE_HOME>/workspaces`; the route mints a fresh UUID-named
 * directory under it per such request.
 */
export function workspacesRoutes(deps: {
  mediator: Mediator;
  queries: WorkspaceQueries;
  cache: PerWorkspaceContainerCache;
  defaultWorkspaceParent: string;
}): Hono {
  const app = new Hono();
  const { mediator, queries, cache, defaultWorkspaceParent } = deps;

  // List all registered workspaces.
  app.get("/", async (c) => {
    try {
      const list = await queries.list();
      return c.json(list);
    } catch (err) {
      return wsErrorJson(c, err, 500);
    }
  });

  // Add a workspace: init the directory + register it. The id is
  // generated server-side. The display name is mandatory; `workspaceDir`
  // is optional — when omitted, the server generates a fresh
  // `<defaultWorkspaceParent>/<uuid>/` directory and uses that.
  //
  // Wire-break note (issue #121): the pre-v2 field name `workdir` and
  // the entire `defaults` block are gone. We don't 400 callers who
  // still send them — extra fields are silently dropped.
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<CreateBodyRaw>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (typeof body.name !== "string") {
      return c.json({ error: "name is required (string)" }, 400);
    }
    let workspaceDir: string;
    let preallocatedId: string;
    if (body.workspaceDir === undefined || body.workspaceDir === null || body.workspaceDir === "") {
      // Auto-generate. Mint the workspace id here and reuse it as the
      // on-disk dir name so the registry id and the directory basename
      // stay coupled — `ls $EMPLOKE_HOME/workspaces/` reads as "list
      // workspace ids" and the dashboard URL `<wsId>` matches the path
      // on disk.
      preallocatedId = randomUUID();
      workspaceDir = path.join(defaultWorkspaceParent, preallocatedId);
    } else if (typeof body.workspaceDir !== "string" || body.workspaceDir.trim() === "") {
      return c.json({ error: "workspaceDir, when present, must be a non-empty string" }, 400);
    } else {
      preallocatedId = randomUUID();
      workspaceDir = path.resolve(body.workspaceDir);
    }

    try {
      const result = await mediator.send(
        new RegisterWorkspaceCommand(preallocatedId, workspaceDir, body.name),
      );
      // Re-query so the response carries the canonical view (incl.
      // server-generated `createdAt`). One extra round-trip against
      // SQLite is cheaper than threading the view back through the
      // command return value.
      const view = await queries.getById(result.id);
      if (!view) {
        // Should be impossible — we just created it. If the row
        // vanished between create and read, surface a typed 5xx so
        // the operator can investigate (likely concurrent unregister
        // during the same tick).
        return c.json({ error: "workspace registered but not readable back" }, 500);
      }
      logEvent(c, "workspace created", {
        workspaceId: view.id,
        name: view.name,
        workspaceDir: view.workspaceDir,
      });
      return c.json(view, 201);
    } catch (err) {
      return wsErrorJson(c, err, 400);
    }
  });

  // Read the currently-selected workspace id.
  app.get("/current", async (c) => {
    try {
      const id = await queries.getCurrentId();
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
      await mediator.send(new SetCurrentWorkspaceCommand(parsed.body.id));
    } catch (err) {
      return wsErrorJson(c, err, 400);
    }
    logEvent(c, "workspace selected as current", { workspaceId: parsed.body.id });
    return c.json({ id: parsed.body.id });
  });

  // Get a single workspace.
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    let view: Awaited<ReturnType<WorkspaceQueries["getById"]>>;
    try {
      view = await queries.getById(id);
    } catch (err) {
      return wsErrorJson(c, err, 500);
    }
    if (!view) {
      return c.json(
        { error: "workspace not registered", code: "WorkspaceNotRegisteredError" },
        404,
      );
    }
    return c.json(view);
  });

  // Update a workspace's mutable fields (name).
  //
  // Wire-break note (issue #121): the `defaults` field on the patch is
  // gone. The only mutable field today is `name`.
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = await parseJsonBody<PatchBodyRaw>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;

    if (body.name === undefined) {
      return c.json({ error: "patch must include 'name'" }, 400);
    }
    if (typeof body.name !== "string") {
      return c.json({ error: "name, when present, must be a string" }, 400);
    }

    try {
      await mediator.send(new RenameWorkspaceCommand(id, body.name));
      cache.invalidate(id);
      const view = await queries.getById(id);
      if (!view) {
        return c.json(
          { error: "workspace not registered", code: "WorkspaceNotRegisteredError" },
          404,
        );
      }
      logEvent(c, "workspace updated", { workspaceId: id, newName: body.name });
      return c.json(view);
    } catch (err) {
      return wsErrorJson(c, err, 500);
    }
  });

  // Remove a workspace. Default behaviour removes only the metadata
  // (the row in `global.db`); user files preserved. Pass
  // `?purge=1` to also rm every emploke-owned subdirectory under the
  // workspace's workspaceDir (sessions/, tasks/). The workspaceDir
  // itself is never removed.
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const purge = c.req.query("purge") === "1";
    try {
      await mediator.send(new UnregisterWorkspaceCommand(id, purge));
    } catch (err) {
      return wsErrorJson(c, err, 400);
    }
    cache.invalidate(id);
    logEvent(c, "workspace deleted", { workspaceId: id, purge });
    return c.body(null, 204);
  });

  // Force the cached `PerWorkspaceContainer` for this id to be rebuilt
  // on the next request. Use case: catalog drift — the user installed
  // an agent through a separate process that mutated the workspace.db
  // catalog tables out-of-band, and the cached `CatalogManager`'s
  // SQLite handle (or downstream caches) need a clean restart.
  //
  // Returns:
  //   - 204 on success (the fresh container is also pre-loaded so the
  //     next request hits cache).
  //   - 404 if the workspace is no longer registered.
  //   - 409 with `code=WorkspaceHasLiveTasksError` when there are live
  //     task subprocesses; reloading would orphan them and race the
  //     fresh `recoverOrphaned` sweep. Caller cancels the tasks (or
  //     waits) and retries.
  //   - 500 for any other load failure, surfaced as `errorBody(err)`.
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
      logEvent(c, "workspace reload requested via API", { workspaceId: id });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof WorkspaceHasLiveTasksError) {
        return c.json(errorBody(err), 409);
      }
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
