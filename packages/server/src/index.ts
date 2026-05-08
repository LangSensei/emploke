import path, { sep as pathSep } from "node:path";
import { Catalog } from "@emploke/catalog";
import { resolveEmplokePaths } from "@emploke/paths";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import {
  type Workspace,
  WorkspaceManager,
  WorkspaceRegistry,
} from "@emploke/workspace";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { assertBindIsSafe, bearerAuth, isLoopbackBind } from "./auth.js";
import { catalogRoutes } from "./routes/catalog/index.js";
import { configRoutes } from "./routes/config.js";
import { runtimesRoutes } from "./routes/runtimes.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import {
  registerWorkspaceWithRuntimes,
  WorkspaceContextCache,
} from "./workspace-context.js";

const paths = resolveEmplokePaths(process.env);

if (process.env.EMPLOKE_SESSIONS_DIR) {
  console.error(
    "EMPLOKE_SESSIONS_DIR is no longer supported.\n" +
      "Sessions now live under <workspace>/sessions; set EMPLOKE_WORKSPACE\n" +
      "to point at the workspace root (default: $EMPLOKE_HOME/workspaces/default).\n",
  );
  process.exit(1);
}

const initialWorkspaceDir = path.resolve(
  process.env.EMPLOKE_WORKSPACE && process.env.EMPLOKE_WORKSPACE.length > 0
    ? process.env.EMPLOKE_WORKSPACE
    : paths.defaultWorkspaceDir,
);

const port = Number(process.env.PORT ?? 3000);
// Bind to loopback by default — the server exposes destructive endpoints
// (DELETE /api/skills/:name, etc.) and is intended as a single-user local
// dashboard. To intentionally expose on the LAN, set EMPLOKE_HOST=0.0.0.0
// AND set EMPLOKE_API_KEY=<token>. Non-loopback bind without an API key is
// refused at startup (see assertBindIsSafe in ./auth).
const hostname = process.env.EMPLOKE_HOST ?? "127.0.0.1";
// When set, every /api/* request must carry `Authorization: Bearer <key>`
// (or `?apiKey=<key>` for dashboards that can't easily set headers).
// Empty / unset = no auth (only safe for loopback bind).
const apiKey = process.env.EMPLOKE_API_KEY;
const staticDir =
  process.env.EMPLOKE_STATIC_DIR ?? path.resolve(import.meta.dirname, "../../dashboard/dist");
// In dev, the dashboard is served by Vite on its own port (:5173) and the
// server only provides /api. In production, pass --serve-static so the server
// serves the dashboard build output too, enabling single-port deployment.
const serveStaticFiles = process.argv.includes("--serve-static");

async function main() {
  assertBindIsSafe(hostname, apiKey);

  const catalog = await Catalog.open({ catalogDir: paths.catalogDir });

  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(new CopilotRuntime());

  // Open the home-level registry, then ensure the initial workspace exists
  // and is recorded. Idempotent on every restart: openOrInit handles the
  // workspace.json side, registry.add throws conflict if it's already
  // registered (which we ignore — already-known is fine).
  const registry = await WorkspaceRegistry.open(paths.registryFile);

  const initialWorkspace = await ensureInitialWorkspace(registry, initialWorkspaceDir);
  await registerWorkspaceWithRuntimes(runtimeRegistry, initialWorkspace.dir);

  const cache = new WorkspaceContextCache({ catalog, runtimeRegistry, registry });

  const app = new Hono();

  if (apiKey && apiKey.trim() !== "") {
    app.use("/api/*", bearerAuth(apiKey.trim()));
  }

  app.route("/api", catalogRoutes(catalog));
  app.route(
    "/api/config",
    configRoutes({
      emplokeHome: paths.home,
      catalogDir: paths.catalogDir,
      host: hostname,
      port,
      pathSeparator: pathSep,
      currentWorkspace: () => registry.current(),
    }),
  );
  app.route("/api/runtimes", runtimesRoutes(runtimeRegistry));
  app.route("/api/workspaces", workspacesRoutes({ registry, cache }));

  // Workspace-scoped sessions. The middleware resolves :name → context and
  // stashes the SessionManager on c.var; the route reads it back via the
  // resolver. 404 if name unknown; 5xx if workspace.json missing/corrupted.
  const sessionsApp = new Hono<{ Variables: { sessionManager: import("@emploke/session").SessionManager } }>();
  sessionsApp.use("/:name/sessions/*", workspaceContextMiddleware(cache));
  sessionsApp.route(
    "/:name/sessions",
    sessionsRoutes((c) => c.get("sessionManager")),
  );
  app.route("/api/workspaces", sessionsApp);

  if (serveStaticFiles) {
    app.use("/*", serveStatic({ root: staticDir }));
  }

  const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
  console.log(`emploke server listening on http://${displayHost}:${port}`);
  console.log(`home:     ${paths.home}`);
  console.log(`catalog:  ${paths.catalogDir}`);
  console.log(`workspace: ${initialWorkspace.dir} (name: ${initialWorkspace.metadata.name})`);
  console.log(`runtimes: ${runtimeRegistry.kinds().join(", ")}`);
  console.log(serveStaticFiles ? `static:   ${staticDir}` : "static:   disabled (dev mode)");
  if (apiKey && apiKey.trim() !== "") {
    console.log("auth:     EMPLOKE_API_KEY set — /api/* requires Bearer auth");
  } else {
    console.log("auth:     disabled (loopback-only deployment)");
  }
  if (!isLoopbackBind(hostname)) {
    console.warn(
      `⚠️  EMPLOKE_HOST=${hostname} — server is reachable from the network. ` +
        "API key gating is enforced; rotate EMPLOKE_API_KEY if it leaks.",
    );
  }
  serve({ fetch: app.fetch, port, hostname });
}

/**
 * Make sure `dir` is a usable workspace and is in the registry. Both
 * operations are idempotent on restart so the bootstrap doesn't get
 * angrier each time the server cycles.
 */
async function ensureInitialWorkspace(
  registry: WorkspaceRegistry,
  dir: string,
): Promise<Workspace> {
  const workspace = await WorkspaceManager.openOrInit(dir);
  if (!registry.has(workspace.metadata.name)) {
    // First time we've seen this workspace under this name. Register +
    // mark as current so the dashboard opens it on next page load.
    await registry.add({ name: workspace.metadata.name, path: workspace.dir });
  }
  if (registry.current() === null) {
    await registry.setCurrent(workspace.metadata.name);
  }
  return workspace;
}

/**
 * Hono middleware: pulls `:name` from the route params, asks the cache for
 * its `WorkspaceContext`, and stashes the per-workspace `SessionManager` on
 * `c.var.sessionManager`. Subsequent route handlers read it back through
 * `c.get("sessionManager")` (typed via the Variables generic on the parent
 * Hono instance).
 *
 *   - 400 if `:name` is missing (shouldn't happen given the route shape;
 *     defensive)
 *   - 404 if the name isn't in the registry
 *   - 5xx if workspace.json is missing/corrupted (cache.load throws)
 */
function workspaceContextMiddleware(
  cache: WorkspaceContextCache,
): MiddlewareHandler<{ Variables: { sessionManager: import("@emploke/session").SessionManager } }> {
  return async (c, next) => {
    const name = c.req.param("name");
    if (!name) return c.json({ error: "missing workspace name" }, 400);
    let ctx;
    try {
      ctx = await cache.get(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: (err as Error)?.name }, 500);
    }
    if (!ctx) {
      return c.json(
        { error: `workspace "${name}" is not registered`, code: "WorkspaceNotRegisteredError" },
        404,
      );
    }
    c.set("sessionManager", ctx.sessions);
    await next();
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
