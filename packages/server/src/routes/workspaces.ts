import path from "node:path";
import {
  RegistryError,
  WorkspaceCorruptedError,
  WorkspaceError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceManager,
  type WorkspaceMetadata,
  WorkspaceNameInvalidError,
  WorkspaceNotFoundError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
  type WorkspaceRegistry,
  type WorkspaceUpdatePatch,
} from "@emploke/workspace";
import type { Context } from "hono";
import { Hono } from "hono";
import type { WorkspaceContextCache } from "../workspace-context.js";
import { errorBody, parseJsonBody } from "./_shared.js";

/**
 * Build a JSON error response for a typed workspace/registry error. Picks
 * a status via `workspaceErrorStatus`, falling back to `fallback` (chosen
 * per-route to reflect what was being attempted: 400 for input writes,
 * 500 for reads / state mutations).
 *
 * The `as any` cast is necessary because Hono's `c.json` second argument
 * is a literal-union of HTTP status codes; we know every value we pass
 * is in that set (each branch of `workspaceErrorStatus` returns
 * {400,404,409,500} and so do all callsite fallbacks), but TS can't
 * narrow a `number` to that union. Centralising the cast here keeps
 * route handlers free of `// biome-ignore` noise.
 */
function wsErrorJson(c: Context, err: unknown, fallback: number) {
  const status = workspaceErrorStatus(err) ?? fallback;
  // biome-ignore lint/suspicious/noExplicitAny: see helper docstring above
  return c.json(errorBody(err), status as any);
}

interface CreateBody {
  path?: unknown;
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
 * Wire shape returned by `GET /api/workspaces`. The dashboard uses this for
 * the workspace selector dropdown. `status` lets the UI render entries
 * whose `workspace.json` has gone missing or corrupt (without removing
 * them  only the user gets to decide that).
 *
 * `id` is the UUID URL key. The user-facing display name lives in
 * `metadata.name`, which is only present when `status === "ok"`.
 */
interface WorkspaceListItem {
  id: string;
  path: string;
  lastOpenedAt?: string;
  status: "ok" | "missing" | "corrupted";
  metadata?: WorkspaceMetadata;
  /** When status !== 'ok', a short human-readable explanation. */
  reason?: string;
}

/**
 * Routes for `/api/workspaces/*` (registry + per-workspace metadata).
 * Workspace-scoped resources (sessions, future tasks/workflows) are NOT
 * mounted here  they live under `/api/workspaces/:id/sessions/*` etc. so
 * the workspace id is part of the resource URL.
 */
export function workspacesRoutes(deps: {
  registry: WorkspaceRegistry;
  cache: WorkspaceContextCache;
}): Hono {
  const app = new Hono();
  const { registry, cache } = deps;

  // List all registered workspaces, joined with their workspace.json
  // metadata. Reads are issued in parallel; per-entry failures are
  // captured into status fields so a single corrupted workspace does not
  // hide the rest of the list.
  app.get("/", async (c) => {
    const items = await Promise.all(
      registry.list().map(async (entry): Promise<WorkspaceListItem> => {
        const base: Pick<WorkspaceListItem, "id" | "path" | "lastOpenedAt"> = {
          id: entry.id,
          path: entry.path,
          ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
        };
        try {
          const ws = await WorkspaceManager.open(entry.path);
          return { ...base, status: "ok", metadata: ws.metadata };
        } catch (err) {
          if (err instanceof WorkspaceNotFoundError) {
            return { ...base, status: "missing", reason: "workspace.json not found" };
          }
          if (err instanceof WorkspaceCorruptedError) {
            return { ...base, status: "corrupted", reason: err.reason };
          }
          throw err;
        }
      }),
    );
    return c.json(items);
  });

  // Add a workspace: open-or-init the directory at `path` with the
  // user-provided display `name`, then register the (id, path) pair with
  // the registry. The id is generated server-side. The display name is
  // mandatory  there is no auto-default and no basename fallback.
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<CreateBody>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (typeof body.path !== "string" || body.path.trim() === "") {
      return c.json({ error: "path is required (string)" }, 400);
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

    const absPath = path.resolve(body.path);
    const initOpts: { name: string; defaults?: WorkspaceMetadata["defaults"] } = {
      name: body.name,
    };
    if (body.defaults && typeof body.defaults === "object") {
      initOpts.defaults = body.defaults as WorkspaceMetadata["defaults"];
    }

    let metadata: WorkspaceMetadata;
    try {
      const ws = await WorkspaceManager.openOrInit(absPath, initOpts);
      metadata = ws.metadata;
    } catch (err) {
      return wsErrorJson(c, err, 400);
    }

    let entry: Awaited<ReturnType<WorkspaceRegistry["add"]>>;
    try {
      entry = await registry.add({ path: absPath });
    } catch (err) {
      return wsErrorJson(c, err, 400);
    }

    return c.json(
      {
        id: entry.id,
        path: entry.path,
        ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
        metadata,
      },
      201,
    );
  });

  // Read the currently-selected workspace id. Returns null when no
  // workspace has ever been selected (fresh install before first request,
  // or when the previously-current workspace was deleted).
  app.get("/current", (c) => c.json({ id: registry.current() }));

  // Set the currently-selected workspace by id. Used by the dashboard
  // topbar so that the next browser session opens with the same workspace
  // selected.
  app.put("/current", async (c) => {
    const parsed = await parseJsonBody<PutCurrentBody>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (typeof parsed.body.id !== "string" || parsed.body.id === "") {
      return c.json({ error: "id is required (string)" }, 400);
    }
    try {
      await registry.setCurrent(parsed.body.id);
    } catch (err) {
      return wsErrorJson(c, err, 400);
    }
    return c.json({ id: parsed.body.id });
  });

  // Get a single workspace's metadata. Useful for the dashboard's
  // workspace settings panel.
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const entry = registry.get(id);
    if (!entry) {
      return c.json(
        { error: "workspace not registered", code: "WorkspaceNotRegisteredError" },
        404,
      );
    }
    try {
      const ws = await WorkspaceManager.open(entry.path);
      return c.json({
        id,
        path: entry.path,
        ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
        metadata: ws.metadata,
      });
    } catch (err) {
      return wsErrorJson(c, err, 500);
    }
  });

  // Update a workspace's metadata in place. Currently exposed: display
  // name (`metadata.name` in workspace.json) and `defaults`. The id,
  // on-disk directory, and URL routing are intentionally NOT touched
  // the id is opaque and stable for the life of the workspace.
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const entry = registry.get(id);
    if (!entry) {
      return c.json(
        { error: "workspace not registered", code: "WorkspaceNotRegisteredError" },
        404,
      );
    }

    const parsed = await parseJsonBody<PatchBody>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;

    const patch: { name?: string; defaults?: WorkspaceMetadata["defaults"] | null } = {};
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
        patch.defaults = body.defaults as WorkspaceMetadata["defaults"];
      }
    }
    if (patch.name === undefined && patch.defaults === undefined) {
      return c.json({ error: "patch must include at least one of: name, defaults" }, 400);
    }

    let updated: WorkspaceMetadata;
    try {
      const ws = await WorkspaceManager.update(entry.path, patch as WorkspaceUpdatePatch);
      updated = ws.metadata;
    } catch (err) {
      return wsErrorJson(c, err, 500);
    }
    // The cached WorkspaceContext holds a stale metadata snapshot.
    cache.invalidate(id);

    return c.json({
      id,
      path: entry.path,
      ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
      metadata: updated,
    });
  });

  // Remove a workspace from the registry. Does NOT delete files on disk
  // the user owns the workspace directory and may want to re-add it later.
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await registry.remove(id);
    } catch (err) {
      return wsErrorJson(c, err, 400);
    }
    cache.invalidate(id);
    return c.body(null, 204);
  });

  return app;
}

/**
 * Map workspace/registry errors to HTTP status codes. Generic 5xx for
 * unrecognised errors; the body is sanitized by `errorBody` so internals
 * never leak.
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
