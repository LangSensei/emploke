import type { Catalog } from "@emploke/catalog";
import { Hono } from "hono";
import { readContentBody, readInstallBody, readMetadataBody } from "./helpers.js";

/**
 * Routes for /api/agents/*. Mounted by `catalogRoutes` at "/agents".
 */
export function agentsRoutes(catalog: Catalog): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(catalog.listAgentEntries()));

  app.get("/:name{.+}", async (c) => {
    const name = c.req.param("name");
    const entry = catalog.getAgentEntry(name);
    if (!entry) return c.json({ error: "not found" }, 404);
    try {
      const content = await catalog.getAgentContent(name);
      return c.json({ ...entry, content });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/", async (c) => {
    const parsed = await readInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const agent = await catalog.installAgent(parsed.sourcePath);
      return c.json(agent, 201);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.put("/:name{.+}", async (c) => {
    const name = c.req.param("name");
    const parsed = await readContentBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const agent = await catalog.updateAgentContent(name, parsed.content);
      return c.json(agent);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.patch("/:name{.+}", async (c) => {
    const name = c.req.param("name");
    const parsed = await readMetadataBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const agent = await catalog.updateAgentMetadata(
        name,
        parsed.body as Parameters<typeof catalog.updateAgentMetadata>[1],
      );
      return c.json(agent);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.delete("/:name{.+}", async (c) => {
    try {
      await catalog.removeAgent(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  return app;
}
