import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path, { sep as pathSep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CatalogManager } from "@emploke/catalog";
import { buildLogger, type Logger, type LogLevel } from "@emploke/logger";
import { resolveEmplokePaths } from "@emploke/paths";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import type { SessionManager } from "@emploke/session";
import type { TaskManager } from "@emploke/task";
import {
  runPkgMigrations,
  SqliteWorkspaceRepository,
  WORKSPACE_MIGRATIONS,
  WorkspaceManager,
} from "@emploke/workspace";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { assertBindIsSafe, isLoopbackBind } from "./auth.js";
import { buildServerContainer } from "./bootstrap.js";
import { accessLog } from "./middleware/access-log.js";
import { requestId } from "./middleware/request-id.js";
import { requestLogger } from "./middleware/request-logger.js";
import { catalogRoutes } from "./routes/catalog/index.js";
import { configRoutes } from "./routes/config.js";
import { healthRoutes } from "./routes/health.js";
import { runtimesRoutes } from "./routes/runtimes.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { tasksRoutes } from "./routes/tasks.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import { buildSubprocessEnvBase } from "./subprocess-env.js";
import { WorkspaceContextCache } from "./workspace-context.js";

// Re-export the route manifest so downstream packages (@emploke/cli,
// future @emploke/mcp) can build typed clients against the same source
// of truth the server's reflection test enforces.
export {
  type AgentWithContent,
  type ApiError,
  type CatalogOverview,
  type CatalogResourcePathParams,
  type ContentUpdateBody,
  defineRoute,
  type HttpMethod,
  listRoutes,
  type McpWithContent,
  type MetadataPatchBody,
  type OkResponse,
  ROUTES,
  type RouteKey,
  type RouteReq,
  type RouteRequest,
  type RouteRes,
  type RouteSpec,
  type SessionCreateBody,
  type SessionDeleteQuery,
  type SessionListQuery,
  type SessionPathParams,
  type SessionSpawnBody,
  type SessionSpawnRes,
  type SkillWithContent,
  type TaskDeleteQuery,
  type TaskDispatchBody,
  type TaskListQuery,
  type TaskPathParams,
  type WorkspaceCreateBody,
  type WorkspaceCurrentPutBody,
  type WorkspaceCurrentRes,
  type WorkspacePatchBody,
  type WorkspacePathParams,
  type WorkspaceSummary,
} from "./routes/manifest.js";

/**
 * Per-request variables stashed on the Hono context by `workspaceContextMiddleware`.
 * Both managers point at the same workspace; routes pull whichever they need.
 */
type WorkspaceVars = {
  sessionManager: SessionManager;
  taskManager: TaskManager;
  catalog: CatalogManager;
};

/**
 * Options accepted by {@link runServer}. Every field is optional; unset
 * fields fall back to the corresponding environment variable (see each
 * field's comment for the exact name) and then to the documented default.
 *
 * Lets the CLI's `serve` command (in `@emploke/cli`) drive the server with
 * structured opts while the historical `bin.ts` and the source-mode
 * `pnpm dev` keep working from env / argv.
 */
export interface RunServerOpts {
  /** Override `EMPLOKE_HOME`. */
  readonly home?: string;
  /** Override `PORT`. Defaults to `8787`. */
  readonly port?: number;
  /** Override `EMPLOKE_HOST`. Defaults to `"127.0.0.1"`. */
  readonly host?: string;
  /**
   * Serve the dashboard SPA from `staticDir`. Default `false` (dev mode —
   * Vite serves the dashboard separately). The bundled binary's `bin.ts`
   * and the CLI's `serve` command default this to `true` for production.
   */
  readonly serveStatic?: boolean;
  /** Override `EMPLOKE_STATIC_DIR`. */
  readonly staticDir?: string;
  /** Override `EMPLOKE_LOG_LEVEL`. Defaults to `"info"`. */
  readonly logLevel?: LogLevel;
  /** Override `EMPLOKE_LOG_FORMAT`. Defaults to `"pretty"`. */
  readonly logFormat?: "pretty" | "json";
}

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

/**
 * Boot the emploke HTTP server. Resolves opts → env → default for every
 * tunable, wires the workspace cache, registers routes, and blocks until
 * `SIGTERM` / `SIGINT` triggers graceful shutdown.
 *
 * Direct callers:
 *  - `packages/server/src/bin.ts` — historical foreground entry, picks
 *    up `--no-serve-static` from argv.
 *  - `packages/cli/src/commands/serve.ts` — `emploke serve` subcommand.
 */
export async function runServer(opts: RunServerOpts = {}): Promise<void> {
  const env = process.env;
  const paths = resolveEmplokePaths(
    opts.home !== undefined ? { ...env, EMPLOKE_HOME: opts.home } : env,
  );

  // `||` instead of `??` so `PORT=""` (common in CI / .env templates with
  // empty values) falls back to the default rather than coercing to 0,
  // which Node treats as "bind to a random ephemeral port" — surprising
  // and almost never what the operator wanted.
  const port = opts.port ?? Number(env.PORT || 8787);
  // Bind to loopback by default — the server exposes destructive endpoints
  // (DELETE /api/workspaces/:id/catalog/skills/:name, etc.) and is intended
  // as a single-user local dashboard. Non-loopback bind is refused at
  // startup (see assertBindIsSafe in ./auth). For remote access, expose
  // the loopback socket through SSH port-forward, a reverse proxy, or
  // a mesh VPN — all of which terminate auth at a layer designed for it.
  const hostname = opts.host ?? env.EMPLOKE_HOST ?? "127.0.0.1";
  const staticDir =
    opts.staticDir ?? env.EMPLOKE_STATIC_DIR ?? resolveStaticDir(import.meta.dirname);
  // In source-mode dev, the dashboard is served by Vite on its own port and the
  // server only provides /api. In production (bundled binary) the bin
  // defaults this to true so the SPA is served alongside /api on one port.
  const serveStaticFiles = opts.serveStatic ?? false;

  assertBindIsSafe(hostname);

  // Phase 0 of issue #135: build the inversify root container at
  // startup so the wiring is exercised end-to-end. No production code
  // path resolves through this container yet; existing managers are
  // still constructed by hand below. Phase 1+ will start migrating
  // bindings into the composeXxxModule stubs and resolving them from
  // here. We `void` the result to make the "intentionally unused"
  // intent explicit to readers and to satisfy biome's noUnusedVars.
  void buildServerContainer();

  // Logger: rotated JSON files under <home>/logs (default) plus stdout
  // for the operator. Level + format honour env so dev can stay pretty
  // and prod can pin JSON-only without code changes.
  const logger: Logger = buildLogger({
    dir: paths.logsDir,
    level: opts.logLevel ?? parseLogLevel(env.EMPLOKE_LOG_LEVEL),
    format: opts.logFormat ?? (env.EMPLOKE_LOG_FORMAT === "json" ? "json" : "pretty"),
  });

  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({
      // Resolve `${sharedDir}` placeholders in MCP specs against
      // `<EMPLOKE_HOME>/shared` so spec authors get a stable per-machine
      // directory without baking host paths into JSON. The literal subdir
      // name lives in `@emploke/paths` (`SHARED_SUBDIR`).
      sharedDir: paths.sharedDir,
    }),
  );

  // Open the workspace registry. The `global.db` SQLite file lives at
  // `<EMPLOKE_HOME>/global.db` and holds every workspace's full record
  // (id, workdir, name, createdAt, defaults) plus cross-workspace
  // state (currently just the current-workspace pointer). The
  // connection's lifetime is bound to the server process — the
  // repository never closes it.
  //
  // We do NOT auto-create a default workspace — the dashboard's
  // landing page prompts the user to create one explicitly (workdir +
  // display name). On first launch the registry is simply empty and
  // the landing page reflects that.
  await mkdir(paths.home, { recursive: true });

  const globalDb = new DatabaseSync(paths.globalDbFile);
  // Run the MigrationCoordinator BEFORE constructing the workspace
  // repository. Post-issue-#123 the repository's `ensureSchema()` is
  // a version-check assertion — bootstrap of the `workspaces` /
  // `global_state` tables now flows through the migration framework.
  // The coordinator is idempotent: on a startup where every pkg is
  // already at HEAD it does one indexed read against `schema_meta`
  // and returns.
  const globalMigrationResult = await runPkgMigrations(globalDb, [
    { pkg: "workspace", migrations: WORKSPACE_MIGRATIONS },
  ]);
  logger.info(
    {
      applied: globalMigrationResult.applied.length,
      alreadyAtTarget: globalMigrationResult.alreadyAtTarget,
      file: paths.globalDbFile,
    },
    "global.db migrations complete",
  );
  const workspaces = new WorkspaceManager(new SqliteWorkspaceRepository({ db: globalDb, logger }));

  const cache = new WorkspaceContextCache({
    runtimeRegistry,
    workspaces,
    logger,
    // Static env bag merged into every task subprocess. Per-run
    // additions (`EMPLOKE_WORKSPACE`, `EMPLOKE_WORKSPACE_DIR`,
    // `EMPLOKE_WORK_KIND`, `EMPLOKE_WORK_ID`, `EMPLOKE_WORK_DIR`) are
    // layered on inside `TaskManager.dispatch` /
    // `SessionManager.assembleLaunchEnv`.
    //
    // `EMPLOKE_SERVER` resolves to a loopback URL when the server is
    // bound to 0.0.0.0 — the spawned subprocess runs on the same host,
    // so dialing 0.0.0.0 would be a misconfiguration on Windows
    // (refused) and a no-op on macOS/Linux. Loopback is the only
    // address guaranteed to work from a child.
    // `EMPLOKE_SHARED_DIR` is the cross-workspace machine-shared
    // state directory — same path the runtime exposes to MCP specs as
    // `${sharedDir}`. The service-internal `<EMPLOKE_HOME>` itself
    // (which holds `global.db`, `runtime.json`, `logs/`) is
    // deliberately NOT exposed to subprocesses — agents have no
    // business touching it. There is no `apiKey` to thread through
    // because emploke ships no auth layer (server is loopback-only;
    // remote access is delegated to SSH / reverse proxy / mesh VPN).
    subprocessEnvBase: buildSubprocessEnvBase({
      hostname,
      port,
      sharedDir: paths.sharedDir,
    }),
  });

  const app = new Hono();

  // Observability middleware chain (issue #58). Order matters:
  //   1. requestId      — mints/honours x-request-id header
  //   2. requestLogger  — builds a pino child bound to { requestId }
  //                       and stashes it on c.var.logger
  //   3. accessLog      — emits one structured info/warn/error line per
  //                       request at end-of-request
  // Mounted globally so /api/health and unauth requests still produce
  // an access line. accessLog skips /api/health internally to keep the
  // poll-loop noise down.
  app.use("*", requestId());
  app.use("*", requestLogger(logger));
  app.use("*", accessLog());

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
      defaultWorkspaceParent: paths.sharedWorkspacesDir,
    }),
  );

  // Workspace-scoped sessions and catalog. The middleware resolves :id
  // context and stashes both `sessionManager` and `catalog` on c.var; each
  // route family reads back the one it needs via the resolver. 404 if id
  // unknown; 5xx if the workspace row is corrupted or workspace.db cannot be opened.
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
  logger.info(
    {
      listen: `http://${displayHost}:${port}`,
      home: paths.home,
      globalDb: paths.globalDbFile,
      workspaces: (await workspaces.list()).length,
      runtimes: runtimeRegistry.kinds(),
      static: serveStaticFiles ? staticDir : null,
      logsDir: paths.logsDir,
    },
    "emploke server starting",
  );
  if (!isLoopbackBind(hostname)) {
    logger.warn(
      { host: hostname },
      "server is reachable from the network; emploke does not ship its own auth — terminate auth at a reverse proxy",
    );
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
    logger.info({ signal }, "shutdown initiated");
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
      logger.error({ err: errorToMeta(err) }, "error closing http server");
    }
    try {
      const ctxs = cache.loaded();
      await Promise.allSettled(ctxs.map((ctx) => ctx.tasks.shutdown()));
    } catch (err) {
      logger.error({ err: errorToMeta(err) }, "error during tasks shutdown");
    }
    try {
      // Close every per-workspace `DatabaseSync` connection so the OS
      // releases the lock on every `workspace.db` file. Required on
      // Windows where `unlink` refuses to remove files with open
      // handles (the CLI integration tests `rm -rf <EMPLOKE_HOME>`
      // immediately after `stop`, and an unclosed `workspace.db`
      // surfaces as `EBUSY: resource busy or locked`).
      cache.closeAll();
    } catch (err) {
      logger.error({ err: errorToMeta(err) }, "error closing workspace contexts");
    }
    try {
      // Close the workspace registry's underlying `DatabaseSync`
      // (`global.db`). Routed through the manager so any future
      // repository impl that owns additional resources (cache,
      // listeners) can release them too.
      //
      // Order: per-workspace contexts FIRST, then the global
      // registry. Repositories never reach back into the registry
      // during close, but the symmetric ordering matches startup
      // (registry opens, then contexts lazy-load) and leaves the
      // registry handle live for the longest possible window in
      // case a future hook needs to record a "shutdown reason" row
      // on its way out.
      workspaces.close();
    } catch (err) {
      logger.error({ err: errorToMeta(err) }, "error closing global.db");
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
 *   - 5xx if the workspace row is corrupted or workspace.db cannot be opened (cache.load throws)
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

/**
 * Parse the `EMPLOKE_LOG_LEVEL` env into one of pino's six supported
 * levels (`trace`, `debug`, `info`, `warn`, `error`, `fatal`). Falls
 * back to `"info"` on any unrecognised / unset value so a misconfigured
 * env never silently disables logging.
 */
function parseLogLevel(raw: string | undefined): LogLevel {
  switch (raw) {
    case "trace":
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "fatal":
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
