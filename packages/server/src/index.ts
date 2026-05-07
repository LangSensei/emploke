import { homedir } from "node:os";
import { resolve } from "node:path";
import { Catalog } from "@emploke/catalog";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { apiRoutes } from "./routes/api.js";

const catalogDir = process.env.EMPLOKE_CATALOG_DIR ?? resolve(homedir(), ".emploke/catalog");
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
// Catalog rescans the filesystem on this interval so that out-of-band changes
// (CLI installs, manual edits, git pulls) are picked up without a server
// restart. 60s is a reasonable trade-off between freshness and IO churn for a
// local single-user catalog with tens-to-hundreds of entries.
const rescanIntervalMs = Number(process.env.EMPLOKE_RESCAN_INTERVAL_MS ?? 60_000);

async function main() {
  const catalog = await Catalog.open({ catalogDir });

  if (rescanIntervalMs > 0) {
    const timer = setInterval(() => {
      catalog.rescan().catch((err) => {
        console.error("[rescan] failed:", err);
      });
    }, rescanIntervalMs);
    // Don't keep the event loop alive just for the timer.
    timer.unref();
  }

  const app = new Hono();

  app.route("/api", apiRoutes(catalog));

  if (serveStaticFiles) {
    app.use("/*", serveStatic({ root: staticDir }));
  }

  const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
  console.log(`emploke server listening on http://${displayHost}:${port}`);
  console.log(`catalog: ${catalogDir}`);
  console.log(serveStaticFiles ? `static: ${staticDir}` : "static: disabled (dev mode)");
  console.log(
    rescanIntervalMs > 0
      ? `rescan: every ${rescanIntervalMs}ms`
      : "rescan: disabled (set EMPLOKE_RESCAN_INTERVAL_MS > 0 to enable)",
  );
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
