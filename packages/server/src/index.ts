import { homedir } from "node:os";
import { sep as pathSep, resolve } from "node:path";
import { Catalog } from "@emploke/catalog";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import { SessionManager } from "@emploke/session";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { assertBindIsSafe, bearerAuth, isLoopbackBind } from "./auth.js";
import { catalogRoutes } from "./routes/catalog/index.js";
import { configRoutes } from "./routes/config.js";
import { runtimesRoutes } from "./routes/runtimes.js";
import { sessionsRoutes } from "./routes/sessions.js";

const catalogDir = process.env.EMPLOKE_CATALOG_DIR ?? resolve(homedir(), ".emploke/catalog");
const sessionsRoot = process.env.EMPLOKE_SESSIONS_DIR ?? resolve(homedir(), ".emploke/sessions");
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
  process.env.EMPLOKE_STATIC_DIR ?? resolve(import.meta.dirname, "../../dashboard/dist");
// In dev, the dashboard is served by Vite on its own port (:5173) and the
// server only provides /api. In production, pass --serve-static so the server
// serves the dashboard build output too, enabling single-port deployment.
const serveStaticFiles = process.argv.includes("--serve-static");

async function main() {
  assertBindIsSafe(hostname, apiKey);

  const catalog = await Catalog.open({ catalogDir });

  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(new CopilotRuntime());

  const sessions = new SessionManager({
    catalog,
    runtimeRegistry,
    root: sessionsRoot,
  });

  const app = new Hono();

  if (apiKey && apiKey.trim() !== "") {
    app.use("/api/*", bearerAuth(apiKey.trim()));
  }

  app.route("/api", catalogRoutes(catalog));
  app.route(
    "/api/config",
    configRoutes({ catalogDir, sessionsRoot, host: hostname, port, pathSeparator: pathSep }),
  );
  app.route("/api/runtimes", runtimesRoutes(runtimeRegistry));
  app.route("/api/sessions", sessionsRoutes(sessions));

  if (serveStaticFiles) {
    app.use("/*", serveStatic({ root: staticDir }));
  }

  const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
  console.log(`emploke server listening on http://${displayHost}:${port}`);
  console.log(`catalog:  ${catalogDir}`);
  console.log(`sessions: ${sessionsRoot}`);
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
