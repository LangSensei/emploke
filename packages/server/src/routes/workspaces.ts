import type { Application } from "@emploke/core";
import { Hono } from "hono";
import { workspacesErrorPolicy } from "./_error-policies/workspaces.js";
import { respondError } from "./_respond-error.js";
import { logEvent, parseJsonBody } from "./_shared.js";
import type {
  WorkspaceCreateBody,
  WorkspaceCurrentPutBody,
  WorkspacePatchBody,
} from "./manifest.js";

type CreateBodyRaw = { [K in keyof WorkspaceCreateBody]?: unknown };
type PutCurrentBodyRaw = { [K in keyof WorkspaceCurrentPutBody]?: unknown };
type PatchBodyRaw = { [K in keyof WorkspacePatchBody]?: unknown };

/**
 * Routes for `/api/workspaces/*`. Workspace-scoped resources (sessions,
 * tasks, catalog) live under `/api/workspaces/:id/...` and are mounted
 * separately so the workspace id is part of the resource URL.
 *
 * This is a thin transport adapter — every endpoint is parse body →
 * dispatch to `@emploke/core` → format response. The orchestration
 * (UUID minting, default workspaceDir, cache invalidation) lives in
 * core so CLI / MCP / SDK consumers get it for free.
 */
export function workspacesRoutes(application: Application): Hono {
  const app = new Hono();
  const { workspaceService: service } = application;

  // List all registered workspaces.
  app.get("/", async (c) => {
    try {
      return c.json(await service.list());
    } catch (err) {
      return respondError(c, err, {
        route: "workspaces.list",
        policy: workspacesErrorPolicy,
        defaultStatus: 500,
      });
    }
  });

  // Create a workspace. `name` required. `workspaceDir` optional — when
  // omitted, core mints `<defaultWorkspaceParent>/<uuid>/`.
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<CreateBodyRaw>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (typeof body.name !== "string") {
      return c.json({ error: "name is required (string)" }, 400);
    }
    if (
      body.workspaceDir !== undefined &&
      body.workspaceDir !== null &&
      (typeof body.workspaceDir !== "string" || body.workspaceDir.trim() === "")
    ) {
      return c.json({ error: "workspaceDir, when present, must be a non-empty string" }, 400);
    }
    try {
      const view = await application.registerWorkspace({
        name: body.name,
        ...(typeof body.workspaceDir === "string" ? { workspaceDir: body.workspaceDir } : {}),
      });
      logEvent(c, "workspace created", {
        workspaceId: view.id,
        name: view.name,
        workspaceDir: view.workspaceDir,
      });
      return c.json(view, 201);
    } catch (err) {
      return respondError(c, err, {
        route: "workspaces.create",
        policy: workspacesErrorPolicy,
      });
    }
  });

  // Read the currently-selected workspace id.
  app.get("/current", async (c) => {
    try {
      return c.json({ id: await service.getLastOpenedId() });
    } catch (err) {
      return respondError(c, err, {
        route: "workspaces.getCurrent",
        policy: workspacesErrorPolicy,
        defaultStatus: 500,
      });
    }
  });

  // Set the currently-selected workspace by id (mark as just-opened).
  app.put("/current", async (c) => {
    const parsed = await parseJsonBody<PutCurrentBodyRaw>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (typeof parsed.body.id !== "string" || parsed.body.id === "") {
      return c.json({ error: "id is required (string)" }, 400);
    }
    try {
      await service.open(parsed.body.id);
    } catch (err) {
      return respondError(c, err, {
        route: "workspaces.setCurrent",
        policy: workspacesErrorPolicy,
      });
    }
    logEvent(c, "workspace selected as current", { workspaceId: parsed.body.id });
    return c.json({ id: parsed.body.id });
  });

  // Get a single workspace.
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    let view: Awaited<ReturnType<typeof service.getById>>;
    try {
      view = await service.getById(id);
    } catch (err) {
      return respondError(c, err, {
        route: "workspaces.get",
        policy: workspacesErrorPolicy,
        meta: { workspaceId: id },
        defaultStatus: 500,
      });
    }
    if (!view) {
      return c.json(
        { error: "workspace not registered", code: "WorkspaceNotRegisteredError" },
        404,
      );
    }
    return c.json(view);
  });

  // Rename a workspace (`name` is currently the only mutable field).
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
      const view = await application.renameWorkspace(id, { newName: body.name });
      if (!view) {
        return c.json(
          { error: "workspace not registered", code: "WorkspaceNotRegisteredError" },
          404,
        );
      }
      logEvent(c, "workspace updated", { workspaceId: id, newName: body.name });
      return c.json(view);
    } catch (err) {
      return respondError(c, err, {
        route: "workspaces.patch",
        policy: workspacesErrorPolicy,
        meta: { workspaceId: id },
        defaultStatus: 500,
      });
    }
  });

  // Remove a workspace (idempotent). Default removes only metadata;
  // `?purge=1` also deletes emploke-owned subdirs (sessions/, tasks/).
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const purge = c.req.query("purge") === "1";
    try {
      await application.unregisterWorkspace(id, { purge });
    } catch (err) {
      return respondError(c, err, {
        route: "workspaces.delete",
        policy: workspacesErrorPolicy,
        meta: { workspaceId: id, purge },
      });
    }
    logEvent(c, "workspace deleted", { workspaceId: id, purge });
    return c.body(null, 204);
  });

  // Force-rebuild the cached per-workspace container.
  //   - 204 on success (the fresh container is also pre-loaded so the
  //     next request hits cache).
  //   - 404 if the workspace is no longer registered.
  //   - 409 with `code=WorkspaceHasLiveTasksError` when reload would
  //     orphan live task subprocesses.
  //   - 500 for any other load failure.
  app.post("/:id/reload", async (c) => {
    const id = c.req.param("id");
    try {
      const view = await application.reloadWorkspace(id);
      if (view === null) {
        return c.json(
          { error: "workspace not registered", code: "WorkspaceNotRegisteredError" },
          404,
        );
      }
      logEvent(c, "workspace reload requested via API", { workspaceId: id });
      return c.body(null, 204);
    } catch (err) {
      // WorkspaceHasLiveTasksError → 409 lives in the workspaces
      // policy now; any other failure falls back to 500 to preserve
      // the pre-refactor `wsErrorJson(c, err, 500)` behavior on this
      // route.
      return respondError(c, err, {
        route: "workspaces.reload",
        policy: workspacesErrorPolicy,
        meta: { workspaceId: id },
        defaultStatus: 500,
      });
    }
  });

  return app;
}
