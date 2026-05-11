import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path, { sep as pathSep } from "node:path";
import type { CatalogManager } from "@emploke/catalog";
import { buildLogger, type Logger, type LogLevel } from "@emploke/logger";
import { resolveEmplokePaths } from "@emploke/paths";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import type { SessionManager } from "@emploke/session";
import type { TaskManager } from "@emploke/task";
import { FsWorkspaceRepository, WorkspaceManager } from "@emploke/workspace";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { assertBindIsSafe, bearerAuth, isLoopbackBind } from "./auth.js";
import { catalogRoutes } from "./routes/catalog/index.js";
import { configRoutes } from "./routes/config.js";
import { healthRoutes } from "./routes/health.js";
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
  catalog: CatalogManager;
};

const paths = resolveEmplokePaths(process.env);

// `||` instead of `??` so `PORT=""` (common in CI / .env templates with
// empty values) falls back to the default rather than coercing to 0,
// which Node treats as "bind to a random ephemeral port"  surprising
// and almost never what the operator wanted.
const port = Number(process.env.PORT || 8787);
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
const staticDir = process.env.EMPLOKE_STATIC_DIR ?? resolveStaticDir(import.meta.dirname);
// In dev, the dashboard is served by Vite on its own port (:8787) and the
// server only provides /api on a different port (default :41817 via the
// `dev` script). In production, pass --serve-static so the server serves
// the dashboard build output too on :8787, enabling single-port deployment.
const serveStaticFiles = process.argv.includes("--serve-static");

/**
 * Pick the dashboard static directory based on layout.
 *
 *   - Bundled binary (`@langsensei/emploke` published to npm): the bundle
 *     lives at `<pkg>/bundle/emploke.js` with assets at `<pkg>/bundle/static/`.
 *     Detect by probing `<dirname>/static/index.html` first.
 *   - Source / monorepo dev: fall back to `packages/dashboard/dist/` two
 *     levels up from `packages/server/dist/`.
 *
 * `EMPLOKE_STATIC_DIR` always wins if set, for ad-hoc deploys that put the
 * SPA somewhere else.
 */
function resolveStaticDir(serverDir: string): string {
  const beside = path.resolve(serverDir, "static");
  if (existsSync(path.join(beside, "index.html"))) return beside;
  return path.resolve(serverDir, "../../dashboard/dist");
}

async function main() {
  assertBindIsSafe(hostname, apiKey);

  // Logger: rotated JSON files under <home>/logs (default) plus stdout
  // for the operator. Level + format honour env so dev can stay pretty
  // and prod can pin JSON-only without code changes.
  const logger: Logger = buildLogger({
    dir: paths.logsDir,
    level: parseLogLevel(process.env.EMPLOKE_LOG_LEVEL),
    format: process.env.EMPLOKE_LOG_FORMAT === "json" ? "json" : "pretty",
  });

  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({
      // Resolve `${globalDir}` placeholders in MCP specs against
      // `<EMPLOKE_HOME>/shared` so spec authors get a stable per-machine
      // directory without baking host paths into JSON.
      globalDir: path.join(paths.home, "shared"),
    }),
  );

  // Open the workspace manager backed by the FS repository. We do NOT
  // auto-create a default workspace — the dashboard's landing page
  // prompts the user to create one explicitly (workdir + display name).
  // On first launch the index file is simply absent and the landing
  // page reflects that.
  const workspaces = new WorkspaceManager(
    new FsWorkspaceRepository({ indexFile: paths.registryFile }),
  );

  const cache = new WorkspaceContextCache({ runtimeRegistry, workspaces, logger });

  const app = new Hono();

  // /api/health is mounted *before* the auth middleware so the dashboard's
  // backoff probe and external liveness checks can poll without first
  // acquiring an API key. The endpoint exposes only `name`, `version`,
  // `startedAt`, and `uptimeSec` — nothing a network observer couldn't
  // already derive from the running socket.
  const { name: serverName, version: serverVersion } = await readServerPackageMeta();
  const startedAtMs = Date.now();
  app.route(
    "/api/health",
    healthRoutes({
      name: serverName,
      version: serverVersion,
      startedAtMs,
    }),
  );

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
      currentWorkspace: () => workspaces.getCurrent(),
    }),
  );
  app.route("/api/runtimes", runtimesRoutes(runtimeRegistry));
  app.route(
    "/api/workspaces",
    workspacesRoutes({
      manager: workspaces,
      cache,
      defaultWorkspaceParent: path.join(paths.home, "workspaces"),
    }),
  );

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
  logger.info("emploke server starting", {
    listen: `http://${displayHost}:${port}`,
    home: paths.home,
    registryFile: paths.registryFile,
    workspaces: (await workspaces.list()).length,
    runtimes: runtimeRegistry.kinds(),
    static: serveStaticFiles ? staticDir : null,
    auth: apiKey && apiKey.trim() !== "" ? "bearer" : "disabled",
    logsDir: paths.logsDir,
  });
  if (!isLoopbackBind(hostname)) {
    logger.warn("server is reachable from the network; rotate EMPLOKE_API_KEY if it leaks", {
      host: hostname,
    });
  }
  const server = serve({ fetch: app.fetch, port, hostname });

  // Graceful shutdown: kill every in-flight task subprocess and wait for
  // the post-exit persistence to finish, so the dashboard sees consistent
  // failure-reason="server shutdown" rows on next start (rather than
  // ghost "running" entries waiting for orphan recovery).
  //
  // Ordering:
  //   1. `server.close()` first — stops accepting new connections and
  //      waits for in-flight HTTP to drain. This prevents two races:
  //      (a) a `POST /tasks` arriving mid-shutdown spawning a new
  //      subprocess after we've already taken the snapshot, and (b) the
  //      first request to a workspace whose context wasn't loaded yet
  //      lazy-instantiating a fresh TaskManager that wasn't in
  //      `cache.loaded()` and would never get drained.
  //   2. `tasks.shutdown()` second — by now no new dispatches can land,
  //      so the snapshot of cached contexts is authoritative.
  //
  // Timeout: 30s. Anything still alive after that gets process.exit(1)
  // so a wedged subprocess can't pin the deploy host indefinitely.
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown initiated", { signal });
    const deadline = setTimeout(() => {
      logger.error("shutdown timed out after 30s; forcing exit");
      process.exit(1);
    }, 30_000);
    deadline.unref();
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
      logger.error("error closing http server", { err: errorToMeta(err) });
    }
    try {
      const ctxs = cache.loaded();
      await Promise.allSettled(ctxs.map((ctx) => ctx.tasks.shutdown()));
    } catch (err) {
      logger.error("error during tasks shutdown", { err: errorToMeta(err) });
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
 * and `CatalogManager` on `c.var`. Sub-route families pull whichever they need
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
  // Boot-time failure: logger may not be alive yet, so fall back to
  // console.error here. Subsequent exits go through the logger.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Parse the `EMPLOKE_LOG_LEVEL` env into one of the four supported
 * levels. Falls back to `"info"` on any unrecognised / unset value so
 * a misconfigured env never silently disables logging.
 */
function parseLogLevel(raw: string | undefined): LogLevel {
  switch (raw) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return raw;
    default:
      return "info";
  }
}

/**
 * Reduce an unknown thrown value to a small structured record suitable
 * for the logger's `meta`. Avoids the noise of pino auto-serialising a
 * full Error (stack lines blow up a JSON line) while keeping the bits
 * that actually help diagnosis.
 */
function errorToMeta(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { value: String(err) };
}

/**
 * Read this server package's `package.json` to surface its name + version
 * via `/api/health`. We resolve relative to `import.meta.url` so the
 * lookup works whether the server runs from `dist/` (production build)
 * or `src/` (tsx dev mode). Failures degrade gracefully — health stays
 * up with placeholder strings rather than crashing the boot.
 */
async function readServerPackageMeta(): Promise<{ name: string; version: string }> {
  // dist/index.js → ../package.json; src/index.ts (via tsx) → ../package.json
  const pkgFile = path.resolve(import.meta.dirname, "..", "package.json");
  try {
    const raw = await readFile(pkgFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof parsed.name === "string" ? parsed.name : "@emploke/server";
    const version = typeof parsed.version === "string" ? parsed.version : "0.0.0-unknown";
    return { name, version };
  } catch {
    // If we cannot read our own package.json (unusual: bundler stripped
    // it, fs perms wonky), fall back to placeholders so /api/health still
    // serves liveness probes.
    return { name: "@emploke/server", version: "0.0.0-unknown" };
  }
}
