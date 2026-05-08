import path from "node:path";
import {
  RegistryError,
  WorkspaceCorruptedError,
  WorkspaceError,
  WorkspaceManager,
  WorkspaceNameConflictError,
  WorkspaceNameInvalidError,
  WorkspaceNotFoundError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
  type WorkspaceMetadata,
  type WorkspaceRegistry,
} from "@emploke/workspace";
import { Hono } from "hono";
import { errorBody, parseJsonBody } from "./_shared.js";
import type { WorkspaceContextCache } from "../workspace-context.js";

interface CreateBody {
  path?: unknown;
  name?: unknown;
  defaults?: unknown;
}

interface PutCurrentBody {
  name?: unknown;
}

/**
 * Wire shape returned by `GET /api/workspaces`. The dashboard uses this for
 * the workspace selector dropdown. `status` lets the UI render entries
 * whose `workspace.json` has gone missing or corrupt (without removing
 * them — only the user gets to decide that).
 */
interface WorkspaceListItem {
  name: string;
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
 * mounted here — they live under `/api/workspaces/:name/sessions/*` etc.
 * so the workspace name is part of the resource URL.
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
        try {
          const ws = await WorkspaceManager.open(entry.path);
          return {
            name: entry.name,
            path: entry.path,
            ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
            status: "ok",
            metadata: ws.metadata,
          };
        } catch (err) {
          if (err instanceof WorkspaceNotFoundError) {
            return {
              name: entry.name,
              path: entry.path,
              ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
              status: "missing",
              reason: "workspace.json not found",
            };
          }
          if (err instanceof WorkspaceCorruptedError) {
            return {
              name: entry.name,
              path: entry.path,
              ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
              status: "corrupted",
              reason: err.reason,
            };
          }
          throw err;
        }
      }),
    );
    return c.json(items);
  });

  // Add a workspace: open-or-init the directory at `path`, then register
  // the (name, path) pair with the registry. POSTing twice with the same
  // path under the same name is idempotent (openOrInit + add yields a name
  // conflict on the second call → we surface 409).
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<CreateBody>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (typeof body.path !== "string" || body.path.trim() === "") {
      return c.json({ error: "path is required (string)" }, 400);
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      return c.json({ error: "name, when present, must be a string" }, 400);
    }
    if (body.defaults !== undefined && (body.defaults === null || typeof body.defaults !== "object" || Array.isArray(body.defaults))) {
      return c.json({ error: "defaults, when present, must be an object" }, 400);
    }

    const absPath = path.resolve(body.path);
    const initOpts: { name?: string; defaults?: WorkspaceMetadata["defaults"] } = {};
    if (typeof body.name === "string") initOpts.name = body.name;
    if (body.defaults && typeof body.defaults === "object") {
      initOpts.defaults = body.defaults as WorkspaceMetadata["defaults"];
    }

    let workspaceName: string;
    try {
      const ws = await WorkspaceManager.openOrInit(absPath, initOpts);
      workspaceName = typeof body.name === "string" ? body.name : ws.metadata.name;
    } catch (err) {
      const status = workspaceErrorStatus(err);
      // biome-ignore lint/suspicious/noExplicitAny: Hono c.json status is finite union.
      return c.json(errorBody(err), (status ?? 400) as any);
    }

    try {
      await registry.add({ name: workspaceName, path: absPath });
    } catch (err) {
      const status = workspaceErrorStatus(err);
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), (status ?? 400) as any);
    }

    const entry = registry.get(workspaceName);
    return c.json(
      {
        name: workspaceName,
        path: absPath,
        ...(entry?.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
      },
      201,
    );
  });

  // Read the currently-selected workspace name. Returns null when no
  // workspace has ever been selected (fresh install before first request).
  app.get("/current", (c) => c.json({ name: registry.current() }));

  // Set the currently-selected workspace. Used by the dashboard topbar so
  // that the next browser session opens with the same workspace selected.
  app.put("/current", async (c) => {
    const parsed = await parseJsonBody<PutCurrentBody>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (typeof parsed.body.name !== "string" || parsed.body.name === "") {
      return c.json({ error: "name is required (string)" }, 400);
    }
    try {
      await registry.setCurrent(parsed.body.name);
    } catch (err) {
      const status = workspaceErrorStatus(err);
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), (status ?? 400) as any);
    }
    return c.json({ name: parsed.body.name });
  });

  // Get a single workspace's metadata. Useful for the dashboard's
  // workspace settings panel.
  app.get("/:name", async (c) => {
    const name = c.req.param("name");
    const entry = registry.get(name);
    if (!entry) {
      return c.json({ error: "workspace not registered", code: "WorkspaceNotRegisteredError" }, 404);
    }
    try {
      const ws = await WorkspaceManager.open(entry.path);
      return c.json({
        name,
        path: entry.path,
        ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
        metadata: ws.metadata,
      });
    } catch (err) {
      const status = workspaceErrorStatus(err);
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), (status ?? 500) as any);
    }
  });

  // Remove a workspace from the registry. Does NOT delete files on disk —
  // the user owns the workspace directory and may want to re-add it later.
  app.delete("/:name", async (c) => {
    const name = c.req.param("name");
    try {
      await registry.remove(name);
    } catch (err) {
      const status = workspaceErrorStatus(err);
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), (status ?? 400) as any);
    }
    cache.invalidate(name);
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
  if (err instanceof WorkspaceNotRegisteredError) return 404;
  if (err instanceof WorkspaceNotFoundError) return 404;
  if (err instanceof WorkspaceNameConflictError) return 409;
  if (err instanceof WorkspacePathConflictError) return 409;
  if (err instanceof WorkspaceCorruptedError) return 500;
  if (err instanceof RegistryError) return 500;
  if (err instanceof WorkspaceError) return 500;
  return null;
}
