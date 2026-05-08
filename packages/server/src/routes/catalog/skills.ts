import type { Catalog } from "@emploke/catalog";
import { Hono } from "hono";
import { readContentBody, readInstallBody, readMetadataBody } from "./helpers.js";

/**
 * Routes for /api/skills/*. Mounted by `catalogRoutes` at "/skills".
 */
export function skillsRoutes(catalog: Catalog): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(catalog.listSkillEntries()));

  app.get("/:name{.+}", async (c) => {
    const name = c.req.param("name");
    const entry = catalog.getSkillEntry(name);
    if (!entry) return c.json({ error: "not found" }, 404);
    try {
      const content = await catalog.getSkillContent(name);
      return c.json({ ...entry, content });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/", async (c) => {
    const parsed = await readInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const skill = await catalog.installSkill(parsed.sourcePath);
      return c.json(skill, 201);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.put("/:name{.+}", async (c) => {
    const name = c.req.param("name");
    const parsed = await readContentBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const skill = await catalog.updateSkillContent(name, parsed.content);
      return c.json(skill);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.patch("/:name{.+}", async (c) => {
    const name = c.req.param("name");
    const parsed = await readMetadataBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const skill = await catalog.updateSkillMetadata(
        name,
        parsed.body as Parameters<typeof catalog.updateSkillMetadata>[1],
      );
      return c.json(skill);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.delete("/:name{.+}", async (c) => {
    try {
      await catalog.removeSkill(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  return app;
}
