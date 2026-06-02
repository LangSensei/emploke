// ADR-002: bump libuv default thread pool from 4 → 16 to give purge
// fs.rm and concurrent dashboard polls headroom. Set BEFORE any other
// import that uses fs / zlib / crypto worker threads (better-sqlite3,
// pino-roll, hono/node-server). `??=` lets operators override via env.
process.env.UV_THREADPOOL_SIZE ??= "16";

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path, { sep as pathSep } from "node:path";
import { logsDir, resolveEmplokeHome } from "@emploke/api-types";
import { type Application, composeApplication, type WorkspaceContext } from "@emploke/core";
import {
  assertCopilotSdkResolvable,
  CopilotRuntime,
  RuntimeRegistry,
  sharedDir,
} from "@emploke/runtime";
import { globalDbPath, workspacesParentDir } from "@emploke/workspace";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { assertBindIsSafe, isLoopbackBind } from "./auth.js";
import { buildLogger, type Logger, type LogLevel } from "./log/build-logger.js";
import { accessLog } from "./middleware/access-log.js";
import { requestId } from "./middleware/request-id.js";
import { requestLogger } from "./middleware/request-logger.js";
import { errorBody } from "./routes/_shared.js";
import { catalogRoutes } from "./routes/catalog/index.js";
import { configRoutes } from "./routes/config.js";
import { healthRoutes } from "./routes/health.js";
import { runtimesRoutes } from "./routes/runtimes.js";
import { scheduledTasksRoutes } from "./routes/scheduled-tasks.js";
import { schedulesRoutes } from "./routes/schedules.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { tasksRoutes } from "./routes/tasks.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import { buildSubprocessEnvBase, SUBPROCESS_ENV_SCRUB_KEYS } from "./subprocess-env.js";

// Route manifest and wire types now live in `@emploke/api-types`; CLI
// and dashboard import them directly from there. `@emploke/server`
// no longer re-exports them — see Issue #255 and the C3 commit body
// for the rationale. Server's public surface is now strictly its
// transport (`runServer`, `RunServerOpts`) + the auth helpers below.

/**
 * Per-request variables stashed on the Hono context by `workspaceContextMiddleware`.
 * Both managers point at the same workspace; routes pull whichever they need.
 */
type WorkspaceVars = {
  workspaceContext: WorkspaceContext;
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
  const home = resolveEmplokeHome(
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

  // Logger: rotated JSON files under <home>/logs (default) plus stdout
  // for the operator. Level + format honour env so dev can stay pretty
  // and prod can pin JSON-only without code changes.
  const logger: Logger = buildLogger({
    dir: logsDir(home),
    level: opts.logLevel ?? parseLogLevel(env.EMPLOKE_LOG_LEVEL),
    format: opts.logFormat ?? (env.EMPLOKE_LOG_FORMAT === "json" ? "json" : "pretty"),
  });

  const runtimeRegistry = new RuntimeRegistry();
  // Fail-fast preflight: confirm `@github/copilot-sdk` (and its
  // transitive `@github/copilot` CLI dep) are resolvable from this
  // process's module graph BEFORE we register the copilot runtime.
  // Without this check, the first `tasks.dispatch` against copilot
  // would throw `ERR_MODULE_NOT_FOUND` deep inside the SDK and
  // bubble back as a generic `HTTP 400 internal error` with no
  // server log — the exact silent-failure mode that motivated this
  // gate (see issue `fix/copilot-sdk-packaging-chain`).
  //
  // The thrown `CopilotSdkUnavailableError` carries the install
  // hint and the underlying `ERR_MODULE_NOT_FOUND` chain so the
  // operator sees actionable output on stderr.
  //
  // Pairs with Change 3 (unmapped-error fall-through logging in
  // tasks.ts) — the preflight catches the common case at boot;
  // the route-level log catches any residual deep-resolution
  // failure at dispatch time. Together they fully eliminate the
  // silent-failure surface.
  assertCopilotSdkResolvable();
  runtimeRegistry.register(
    new CopilotRuntime({
      // Resolve `${sharedDir}` placeholders in MCP specs against
      // `<EMPLOKE_HOME>/shared` so spec authors get a stable per-machine
      // directory without baking host paths into JSON.
      sharedDir: sharedDir(home),
      // Runtime owns the cross-cutting env (`EMPLOKE_SERVER`,
      // `EMPLOKE_SHARED_DIR`, plus the `EMPLOKE_HOME` scrub on the
      // headless path) that every spawned agent process inherits.
      // Session / Task add their own work-context env (`EMPLOKE_WORK_*`,
      // `EMPLOKE_WORKSPACE*`) on top via the runtime's launchHeadless
      // / buildInteractiveLaunch.
      subprocessEnvBase: buildSubprocessEnvBase({
        hostname,
        port,
        sharedDir: sharedDir(home),
      }),
      subprocessEnvScrub: SUBPROCESS_ENV_SCRUB_KEYS,
    }),
  );

  // Open the workspace registry (`global.db`) via the workspace pkg's
  // composer. Phase 2 / ADR-3 (#139) replaced the previous
  // `DatabaseSync` + custom migration framework with a Drizzle-managed
  // entity layout; the encapsulation refactor (P1-5 follow-up) moved
  // the Drizzle init into the workspace pkg itself, so the server
  // only passes the DB file path. On first launch the workspace
  // composer creates the schema from its own entity list; on
  // subsequent launches `orm.schema.updateSchema()` is a no-op for
  // matching schemas. (Production hardening: switch to
  // `orm.migrator.up()` once a release branch has cut a migrations
  // baseline beyond `Migration00000000000000_initial`.)
  //
  // We do NOT auto-create a default workspace — the dashboard's
  // landing page prompts the user to create one explicitly.
  await mkdir(home, { recursive: true });

  const composition = await composeApplication({
    workspace: { dbFile: globalDbPath(home) },
    runtimeRegistry,
    defaultWorkspaceParent: workspacesParentDir(home),
    logger,
  });
  logger.info({ file: globalDbPath(home) }, "global.db opened via workspace pkg (Phase 2 / ADR-3)");

  const workspaceService = composition.workspaceService;
  const application = composition;

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
      emplokeHome: home,
      host: hostname,
      port,
      pathSeparator: pathSep,
      currentWorkspace: () => workspaceService.getLastOpenedId(),
    }),
  );
  app.route("/api/runtimes", runtimesRoutes(runtimeRegistry));
  app.route("/api/workspaces", workspacesRoutes(application));

  // Workspace-scoped sessions / tasks / catalog. Middleware resolves the
  // `:id` workspace once and stashes the whole `WorkspaceContext` on
  // c.var; each route family reads the bits it needs. 404 if id is not
  // registered; 5xx if workspace.db cannot be opened.
  const sessionsApp = new Hono<{ Variables: WorkspaceVars }>();
  sessionsApp.use("/:id/sessions/*", workspaceContextMiddleware(application));
  sessionsApp.route(
    "/:id/sessions",
    sessionsRoutes((c) => c.get("workspaceContext")),
  );
  app.route("/api/workspaces", sessionsApp);

  const tasksApp = new Hono<{ Variables: WorkspaceVars }>();
  tasksApp.use("/:id/tasks/*", workspaceContextMiddleware(application));
  tasksApp.route(
    "/:id/tasks",
    tasksRoutes((c) => c.get("workspaceContext").tasks),
  );
  app.route("/api/workspaces", tasksApp);

  // `/scheduled-tasks` is the schedule-origin sibling of `/tasks`. It
  // shares the same workspace-scoped TaskService (via the same
  // `workspaceContext.tasks` resolver) so storage / cancellation /
  // dispatch all observe one in-memory state — splitting at the route
  // layer, not the service layer, keeps the seam at the URL where it
  // belongs.
  const scheduledTasksApp = new Hono<{ Variables: WorkspaceVars }>();
  scheduledTasksApp.use("/:id/scheduled-tasks/*", workspaceContextMiddleware(application));
  scheduledTasksApp.route(
    "/:id/scheduled-tasks",
    scheduledTasksRoutes((c) => c.get("workspaceContext").tasks),
  );
  app.route("/api/workspaces", scheduledTasksApp);

  // Schedule CRUD + run + preview. Sibling of `/scheduled-tasks` —
  // that route is read-only over the dispatched task list; this
  // route owns the trigger entities themselves. Both share the same
  // workspace-scoped per-context state via the middleware.
  const schedulesApp = new Hono<{ Variables: WorkspaceVars }>();
  schedulesApp.use("/:id/schedules/*", workspaceContextMiddleware(application));
  schedulesApp.route(
    "/:id/schedules",
    schedulesRoutes((c) => c.get("workspaceContext").schedules),
  );
  app.route("/api/workspaces", schedulesApp);

  const catalogApp = new Hono<{ Variables: WorkspaceVars }>();
  catalogApp.use("/:id/catalog/*", workspaceContextMiddleware(application));
  catalogApp.route(
    "/:id/catalog",
    catalogRoutes((c) => c.get("workspaceContext").catalog),
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
      home: home,
      globalDb: globalDbPath(home),
      workspaces: (await workspaceService.list()).length,
      runtimes: runtimeRegistry.kinds(),
      static: serveStaticFiles ? staticDir : null,
      logsDir: logsDir(home),
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
  //      lazy-instantiating a fresh TaskService that wasn't in
  //      `application.loadedContexts()` and would never get drained.
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
      logger.error({ err }, "error closing http server");
    }
    try {
      const ctxs = application.loadedContexts();
      await Promise.allSettled(ctxs.map((ctx) => ctx.tasks.shutdown()));
    } catch (err) {
      logger.error({ err }, "error during tasks shutdown");
    }
    try {
      // Close the workspace registry's underlying Drizzle DB handle
      // (`global.db`) plus every per-workspace SQLite handle via
      // `application.close()` (composes the internal context
      // registry's `closeAll()` then the global handle). Releasing
      // the SQLite files is required on Windows where `unlink`
      // refuses to remove files with open handles (the CLI
      // integration tests `rm -rf <EMPLOKE_HOME>` immediately after
      // `stop`, and an unclosed `workspace.db` surfaces as `EBUSY:
      // resource busy or locked`).
      await application.close();
    } catch (err) {
      logger.error({ err }, "error closing global.db");
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
 * Hono middleware: pulls `:id` from the route params, asks the
 * application for its `WorkspaceContext`, and stashes it on
 * `c.var.workspaceContext` as a single field. Sub-routes pull
 * whichever service they need off the context (sessions read
 * `c.get("workspaceContext").sessions`; catalog reads
 * `c.get("workspaceContext").catalog`; etc.).
 *
 *   - 400 if `:id` is missing (shouldn't happen given the route shape;
 *     defensive)
 *   - 404 if the id isn't in the registry
 *   - 5xx if the workspace row is corrupted or workspace.db cannot be opened (getContext throws)
 */
function workspaceContextMiddleware(
  application: Application,
): MiddlewareHandler<{ Variables: WorkspaceVars }> {
  return async (c, next) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing workspace id" }, 400);
    let context: WorkspaceContext | null;
    try {
      context = await application.getContext(id);
    } catch (err) {
      // Use the canonical `errorBody` envelope so the 500 body goes
      // through the same `SAFE_ERROR_NAMES` allow-list every other 5xx
      // response uses. Echoing raw `err.message` here would bypass the
      // gate and leak host paths / Node fs error strings behind a
      // reverse proxy (loopback bind mitigates exploitability today,
      // not tomorrow).
      return c.json(errorBody(err), 500);
    }
    if (!context) {
      return c.json(
        { error: `workspace "${id}" is not registered`, code: "WorkspaceNotRegisteredError" },
        404,
      );
    }
    c.set("workspaceContext", context);
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
