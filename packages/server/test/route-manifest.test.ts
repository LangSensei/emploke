/**
 * Route manifest reflection test.
 *
 * Mounts every route group on a throwaway Hono app the same way
 * `runServer` (in `../src/index.ts`) does in production, walks
 * `app.routes` (Hono's side-effect record of every registered handler),
 * and asserts the resulting set of `{method, path}` pairs matches
 * `ROUTE_MANIFEST` exactly.
 *
 * What this catches:
 *  - Adding a route in a handler file without adding the matching
 *    {@link ROUTES} entry → fail.
 *  - Adding a {@link ROUTES} entry without registering a handler → fail.
 *  - Renaming a path on either side → fail.
 *  - Changing the HTTP verb on either side → fail.
 *
 * What this does NOT catch:
 *  - Request / response **body** shape drift between manifest types and
 *    handler logic. That's the next layer (typedHandler wrapper or a
 *    runtime contract test); tracked as future work in the plan.
 */

import { type CatalogOptions, CatalogService } from "@emploke/catalog";
import pino from "pino";

const silentLogger = pino({ level: "silent" });

import {
  type Application,
  type HttpMethod,
  listRoutes,
  type RouteSpec,
  type WorkspaceContext,
} from "@emploke/api";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import type { ScheduleService } from "@emploke/schedule";
import type { SessionService } from "@emploke/session";
import type { TaskService } from "@emploke/task";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { catalogRoutes } from "../src/routes/catalog/index.js";
import { configRoutes } from "../src/routes/config.js";
import { healthRoutes } from "../src/routes/health.js";
import { runtimesRoutes } from "../src/routes/runtimes.js";
import { scheduledTasksRoutes } from "../src/routes/scheduled-tasks.js";
import { schedulesRoutes } from "../src/routes/schedules.js";
import { sessionsRoutes } from "../src/routes/sessions.js";
import { tasksRoutes } from "../src/routes/tasks.js";
import { workspacesRoutes } from "../src/routes/workspaces.js";

/**
 * Mirror of `runServer`'s mount tree, parameterised over deps so the
 * test can pass throwaway stubs. Production wires real managers; we
 * only care about the *shape* of registered routes here.
 */
function buildAppForTest(): Hono {
  const app = new Hono();

  app.route(
    "/api/health",
    healthRoutes({ name: "@emploke/server", version: "0.0.0", startedAtMs: 0 }),
  );

  app.route(
    "/api/config",
    configRoutes({
      emplokeHome: "/tmp",
      host: "127.0.0.1",
      port: 8787,
      pathSeparator: "/",
      currentWorkspace: () => null,
    }),
  );

  // RuntimeRegistry needs at least the copilot runtime registered so
  // `kinds()` returns a non-empty list — but enumeration of routes is
  // independent of the registry's contents. We register a real one to
  // mirror production fidelity.
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(new CopilotRuntime({ sharedDir: "/tmp/shared" }));
  app.route("/api/runtimes", runtimesRoutes(runtimeRegistry));

  app.route("/api/workspaces", workspacesRoutes(stubApplication()));

  // Workspace-scoped families. We pass resolvers that throw if invoked,
  // since the test never makes real requests — only enumerates the
  // registered paths.
  const sessionsApp = new Hono();
  sessionsApp.route(
    "/:id/sessions",
    sessionsRoutes(() => ({ sessions: stubSessionManager() }) as unknown as WorkspaceContext),
  );
  app.route("/api/workspaces", sessionsApp);

  const tasksApp = new Hono();
  tasksApp.route(
    "/:id/tasks",
    tasksRoutes(() => stubTaskManager()),
  );
  app.route("/api/workspaces", tasksApp);

  const scheduledTasksApp = new Hono();
  scheduledTasksApp.route(
    "/:id/scheduled-tasks",
    scheduledTasksRoutes(() => stubTaskManager()),
  );
  app.route("/api/workspaces", scheduledTasksApp);

  const schedulesApp = new Hono();
  schedulesApp.route(
    "/:id/schedules",
    schedulesRoutes(() => stubScheduleService()),
  );
  app.route("/api/workspaces", schedulesApp);

  const catalogApp = new Hono();
  catalogApp.route(
    "/:id/catalog",
    catalogRoutes(() => stubCatalogFacade()),
  );
  app.route("/api/workspaces", catalogApp);

  return app;
}

describe("route manifest", () => {
  it("ROUTES exactly matches the routes Hono registered", () => {
    const app = buildAppForTest();
    const actual = new Set<string>(
      app.routes
        // Hono auto-registers an `ALL` route for `*` mount points;
        // those are middleware infrastructure, not user-facing routes.
        // The manifest only lists explicit user routes, so filter
        // `ALL` out before comparison.
        .filter((r) => r.method !== "ALL")
        .map((r) => `${r.method} ${normalizePath(r.path)}`),
    );
    const declared = new Set<string>(listRoutes().map((r) => `${r.method} ${r.path}`));

    const missingFromManifest = [...actual].filter((k) => !declared.has(k)).sort();
    const missingFromApp = [...declared].filter((k) => !actual.has(k)).sort();

    expect(
      missingFromManifest,
      "registered but not in ROUTES (forgot to update manifest?)",
    ).toEqual([]);
    expect(missingFromApp, "in ROUTES but not registered (forgot to add handler?)").toEqual([]);
  });

  it("listRoutes returns 65 entries (the current API surface)", () => {
    // Canary against silent surface drift — updating the manifest AND
    // the handler in a single commit keeps this assertion satisfied
    // and forces a deliberate ++N here, which surfaces in code review.
    // Historical bumps are reachable via `git log -p`; the running
    // total is the only fact a reader needs today.
    expect(listRoutes()).toHaveLength(65);
  });
});

/**
 * Hono's `path` strings sometimes carry trailing wildcards (`/*`) for
 * mount middleware. The manifest does not list those — they're
 * scaffolding. Strip them so the comparison is apples-to-apples.
 *
 * Also collapses any `:name{regex}` segments to plain `:name` since the
 * manifest declares the canonical placeholder form (`:name`); the
 * `{.+}` regex on `/:name{.+}` exists only to allow slashes in the
 * matched value, which is a Hono-specific routing detail.
 */
function normalizePath(path: string): string {
  let p = path;
  // `/foo/*` → `/foo`
  if (p.endsWith("/*")) p = p.slice(0, -2);
  // `:name{regex}` → `:name`
  p = p.replace(/:(\w+)\{[^}]+\}/g, ":$1");
  // Hono normalises `/api/workspaces` and `/api/workspaces/` differently
  // depending on registration order; collapse trailing slashes.
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

// ─── Stubs ─────────────────────────────────────────────────────────────
// All stubs throw on use so accidentally invoking a handler in a future
// test surfaces fast.

function stubApplication(): Application {
  // `workspacesRoutes` destructures `application.workspaceService` at
  // construction. Return a nested Proxy so the destructure succeeds but
  // any actual method call surfaces fast.
  const propStub = new Proxy(
    {},
    {
      get() {
        throw new Error("stubApplication: not callable");
      },
    },
  );
  return new Proxy({} as Application, {
    get() {
      return propStub;
    },
  });
}

function stubSessionManager(): SessionService {
  return new Proxy({} as SessionService, {
    get() {
      throw new Error("stubSessionManager: not callable");
    },
  });
}

function stubTaskManager(): TaskService {
  return new Proxy({} as TaskService, {
    get() {
      throw new Error("stubTaskManager: not callable");
    },
  });
}

function stubScheduleService(): ScheduleService {
  return new Proxy({} as ScheduleService, {
    get() {
      throw new Error("stubScheduleService: not callable");
    },
  });
}

function stubCatalogFacade(): CatalogService {
  // CatalogService is a class with options; for route enumeration we
  // never call any method, but constructing one keeps types honest.
  // Use a Proxy to short-circuit any accidental method call.
  return new Proxy({} as CatalogService, {
    get() {
      throw new Error("stubCatalogManager: not callable");
    },
  });
}

// Reference compile-time helpers so unused-import lint stays quiet
// without a `_unused` prefix that hides the contract.
const _typeChecks: { spec: RouteSpec; method: HttpMethod; mgr?: typeof CatalogService } = {
  spec: { method: "GET", path: "/", _req: {}, _res: undefined },
  method: "GET",
  mgr: CatalogService,
};
void _typeChecks;
void silentLogger;
void ({} as CatalogOptions);
