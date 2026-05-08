import { homedir } from "node:os";
import { sep as pathSep, resolve } from "node:path";
import { Catalog } from "@emploke/catalog";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import { SessionManager } from "@emploke/session";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { catalogRoutes } from "./routes/catalog/index.js";
import { configRoutes } from "./routes/config.js";
import { runtimesRoutes } from "./routes/runtimes.js";
import { sessionsRoutes } from "./routes/sessions.js";

const catalogDir = process.env.EMPLOKE_CATALOG_DIR ?? resolve(homedir(), ".emploke/catalog");
const sessionsRoot = process.env.EMPLOKE_SESSIONS_DIR ?? resolve(homedir(), ".emploke/sessions");
const port = Number(process.env.PORT ?? 3000);
// Bind to loopback by default — the server exposes destructive endpoints
// (DELETE /api/skills/:name, etc.) and is intended as a single-user local
// dashboard. To intentionally expose on the LAN, set EMPLOKE_HOST=0.0.0.0.
const hostname = process.env.EMPLOKE_HOST ?? "127.0.0.1";
const staticDir =
  process.env.EMPLOKE_STATIC_DIR ?? resolve(import.meta.dirname, "../../dashboard/dist");
// In dev, the dashboard is served by Vite on its own port (:5173) and the
// server only provides /api. In production, pass --serve-static so the server
// serves the dashboard build output too, enabling single-port deployment.
const serveStaticFiles = process.argv.includes("--serve-static");

async function main() {
  const catalog = await Catalog.open({ catalogDir });

  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(new CopilotRuntime());

  const sessions = new SessionManager({
    catalog,
    runtimeRegistry,
    root: sessionsRoot,
  });

  const app = new Hono();

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
  if (hostname === "0.0.0.0") {
    console.warn(
      "⚠️  EMPLOKE_HOST=0.0.0.0 — server is reachable from the local network. " +
        "Anyone on this network can call destructive endpoints (DELETE /api/...).",
    );
  }
  serve({ fetch: app.fetch, port, hostname });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
