import { resolve } from "node:path";
import { Catalog } from "@emploke/catalog";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { apiRoutes } from "./routes/api.js";

const catalogDir =
  process.env.EMPLOKE_CATALOG_DIR ?? resolve(process.env.HOME ?? "~", ".emploke/catalog");
const port = Number(process.env.PORT ?? 3000);
// Bind to loopback by default — the server exposes destructive endpoints
// (DELETE /api/skills/:name, etc.) and is intended as a single-user local
// dashboard. To intentionally expose on the LAN, set EMPLOKE_HOST=0.0.0.0.
const hostname = process.env.EMPLOKE_HOST ?? "127.0.0.1";
const staticDir =
  process.env.EMPLOKE_STATIC_DIR ?? resolve(import.meta.dirname, "../../dashboard/dist");

async function main() {
  const catalog = await Catalog.open({ catalogDir });

  const app = new Hono();

  // API routes
  app.route("/api", apiRoutes(catalog));

  // Static files (dashboard build output)
  app.use("/*", serveStatic({ root: staticDir }));

  const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
  console.log(`emploke server listening on http://${displayHost}:${port}`);
  console.log(`catalog: ${catalogDir}`);
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
