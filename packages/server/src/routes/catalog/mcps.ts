import type { Catalog } from "@emploke/catalog";
import { Hono } from "hono";
import { readContentBody, readInstallBody } from "./helpers.js";

/**
 * Routes for /api/mcps/*. Mounted by `catalogRoutes` at "/mcps".
 *
 * MCPs do not have a metadata PATCH endpoint — they're config-only blobs
 * with no status/disabled state to flip.
 */
export function mcpsRoutes(catalog: Catalog): Hono {
  const app = new Hono();

  app.get("/", (c) =>
    c.json(catalog.listMcps().map((name) => ({ name, path: catalog.getMcpPath(name) }))),
  );

  app.get("/:name{.+}", async (c) => {
    const name = c.req.param("name");
    const path = catalog.getMcpPath(name);
    if (!path) return c.json({ error: "not found" }, 404);
    try {
      const content = await catalog.getMcpContent(name);
      return c.json({ name, path, content });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/", async (c) => {
    const parsed = await readInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const name = await catalog.installMcp(parsed.sourcePath, parsed.name);
      return c.json({ name, path: catalog.getMcpPath(name) }, 201);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.put("/:name{.+}", async (c) => {
    const name = c.req.param("name");
    const parsed = await readContentBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      await catalog.updateMcpContent(name, parsed.content);
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.delete("/:name{.+}", async (c) => {
    try {
      await catalog.removeMcp(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  return app;
}
