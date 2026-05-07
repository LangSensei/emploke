import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Catalog } from "@emploke/catalog";
import { apiRoutes } from "./routes/api.js";
import { resolve } from "node:path";

const catalogDir = process.env.EMPLOKE_CATALOG_DIR ?? resolve(process.env.HOME ?? "~", ".emploke/catalog");
const port = Number(process.env.PORT ?? 3000);

async function main() {
  const catalog = await Catalog.open({ catalogDir });

  const app = new Hono();

  // API routes
  app.route("/api", apiRoutes(catalog));

  // Static files (dashboard build output)
  app.use("/*", serveStatic({ root: resolve(import.meta.dirname, "../../dashboard/dist") }));

  console.log(`emploke server listening on http://localhost:${port}`);
  console.log(`catalog: ${catalogDir}`);
  serve({ fetch: app.fetch, port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
