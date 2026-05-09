import path, { sep as pathSep } from "node:path";
import type { Catalog } from "@emploke/catalog";
import { resolveEmplokePaths } from "@emploke/paths";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import type { SessionManager } from "@emploke/session";
import type { TaskManager } from "@emploke/task";
import { WorkspaceRegistry } from "@emploke/workspace";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { assertBindIsSafe, bearerAuth, isLoopbackBind } from "./auth.js";
import { catalogRoutes } from "./routes/catalog/index.js";
import { configRoutes } from "./routes/config.js";
import { runtimesRoutes } from "./routes/runtimes.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { tasksRoutes } from "./routes/tasks.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import { WorkspaceContextCache } from "./workspace-context.js";

/**
 * Per-request variables stashed on the Hono context by `workspaceContextMiddleware`.
 * Both managers point at the same workspace; routes pull whichever they need.
 */
type WorkspaceVars = {
  sessionManager: SessionManager;
  taskManager: TaskManager;
  catalog: Catalog;
};

const paths = resolveEmplokePaths(process.env);

const port = Number(process.env.PORT ?? 3000);
// Bind to loopback by default  the server exposes destructive endpoints
// (DELETE /api/workspaces/:id/catalog/skills/:name, etc.) and is intended
// as a single-user local dashboard. To intentionally expose on the LAN, set
// EMPLOKE_HOST=0.0.0.0 AND set EMPLOKE_API_KEY=<token>. Non-loopback bind
// without an API key is refused at startup (see assertBindIsSafe in ./auth).
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

  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(new CopilotRuntime());

  // Open the home-level registry. We do NOT auto-create a default
  // workspace  the dashboard's landing page prompts the user to create
  // one explicitly (path + display name). On first launch the registry
  // is simply empty and the landing page reflects that.
  const registry = await WorkspaceRegistry.open(paths.registryFile);

  const cache = new WorkspaceContextCache({ runtimeRegistry, registry });

  const app = new Hono();

  if (apiKey && apiKey.trim() !== "") {
    app.use("/api/*", bearerAuth(apiKey.trim()));
  }

  app.route(
    "/api/config",
    configRoutes({
      emplokeHome: paths.home,
      host: hostname,
      port,
      pathSeparator: pathSep,
      currentWorkspace: () => registry.current(),
    }),
  );
  app.route("/api/runtimes", runtimesRoutes(runtimeRegistry));
  app.route("/api/workspaces", workspacesRoutes({ registry, cache }));

  // Workspace-scoped sessions and catalog. The middleware resolves :id
  // context and stashes both `sessionManager` and `catalog` on c.var; each
  // route family reads back the one it needs via the resolver. 404 if id
  // unknown; 5xx if workspace.json missing/corrupted.
  const sessionsApp = new Hono<{ Variables: WorkspaceVars }>();
  sessionsApp.use("/:id/sessions/*", workspaceContextMiddleware(cache));
  sessionsApp.route(
    "/:id/sessions",
    sessionsRoutes((c) => c.get("sessionManager")),
  );
  app.route("/api/workspaces", sessionsApp);

  // Workspace-scoped tasks. Same middleware shape as sessions.
  const tasksApp = new Hono<{ Variables: WorkspaceVars }>();
  tasksApp.use("/:id/tasks/*", workspaceContextMiddleware(cache));
  tasksApp.route(
    "/:id/tasks",
    tasksRoutes((c) => c.get("taskManager")),
  );
  app.route("/api/workspaces", tasksApp);

  const catalogApp = new Hono<{ Variables: WorkspaceVars }>();
  catalogApp.use("/:id/catalog/*", workspaceContextMiddleware(cache));
  catalogApp.route(
    "/:id/catalog",
    catalogRoutes((c) => c.get("catalog")),
  );
  app.route("/api/workspaces", catalogApp);

  if (serveStaticFiles) {
    app.use("/*", serveStatic({ root: staticDir }));
    // SPA history fallback: any non-API GET that didn't resolve to a
    // static asset (i.e. a deep route like /workspaces/<uuid>/catalog)
    // should hand back index.html so client-side React Router can take
    // over. Hono walks middleware in registration order and only reaches
    // this handler if the static layer above produced no match.
    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api/")) return next();
      const indexPath = path.join(staticDir, "index.html");
      try {
        const fs = await import("node:fs/promises");
        const html = await fs.readFile(indexPath, "utf8");
        return c.html(html);
      } catch {
        return next();
      }
    });
  }

  const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
  console.log(`emploke server listening on http://${displayHost}:${port}`);
  console.log(`home:     ${paths.home}`);
  console.log(`registry: ${paths.registryFile} (${registry.list().length} workspace(s))`);
  console.log(`runtimes: ${runtimeRegistry.kinds().join(", ")}`);
  console.log(serveStaticFiles ? `static:   ${staticDir}` : "static:   disabled (dev mode)");
  if (apiKey && apiKey.trim() !== "") {
    console.log("auth:     EMPLOKE_API_KEY set  /api/* requires Bearer auth");
  } else {
    console.log("auth:     disabled (loopback-only deployment)");
  }
  if (!isLoopbackBind(hostname)) {
    console.warn(
      `  EMPLOKE_HOST=${hostname}  server is reachable from the network. ` +
        "API key gating is enforced; rotate EMPLOKE_API_KEY if it leaks.",
    );
  }
  const server = serve({ fetch: app.fetch, port, hostname });

  // Graceful shutdown: kill every in-flight task subprocess and wait for
  // the post-exit persistence to finish, so the dashboard sees consistent
  // failure-reason="server shutdown" rows on next start (rather than
  // ghost "running" entries waiting for orphan recovery).
  //
  // Timeout: 30s. Anything still alive after that gets process.exit(1) so
  // a wedged subprocess can't pin the deploy host indefinitely.
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down…`);
    const deadline = setTimeout(() => {
      console.error("shutdown timed out after 30s; forcing exit");
      process.exit(1);
    }, 30_000);
    deadline.unref();
    try {
      const ctxs = cache.loaded();
      await Promise.allSettled(ctxs.map((ctx) => ctx.tasks.shutdown()));
    } catch (err) {
      console.error("error during tasks shutdown", err);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        // @hono/node-server's `serve` returns a node http.Server, which
        // has a standard `close(cb)`. Stop accepting new connections,
        // then wait for in-flight ones to drain.
        (server as unknown as { close: (cb?: (err?: Error) => void) => void }).close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      console.error("error closing http server", err);
    }
    clearTimeout(deadline);
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });
}

/**
 * Hono middleware: pulls `:id` from the route params, asks the cache for
 * its `WorkspaceContext`, and stashes the per-workspace `SessionManager`
 * and `Catalog` on `c.var`. Sub-route families pull whichever they need
 * (sessions read `c.get("sessionManager")`; catalog reads `c.get("catalog")`).
 *
 *   - 400 if `:id` is missing (shouldn't happen given the route shape;
 *     defensive)
 *   - 404 if the id isn't in the registry
 *   - 5xx if workspace.json is missing/corrupted (cache.load throws)
 */
function workspaceContextMiddleware(
  cache: WorkspaceContextCache,
): MiddlewareHandler<{ Variables: WorkspaceVars }> {
  return async (c, next) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing workspace id" }, 400);
    let ctx: Awaited<ReturnType<WorkspaceContextCache["get"]>>;
    try {
      ctx = await cache.get(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: (err as Error)?.name }, 500);
    }
    if (!ctx) {
      return c.json(
        { error: `workspace "${id}" is not registered`, code: "WorkspaceNotRegisteredError" },
        404,
      );
    }
    c.set("sessionManager", ctx.sessions);
    c.set("taskManager", ctx.tasks);
    c.set("catalog", ctx.catalog);
    await next();
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
