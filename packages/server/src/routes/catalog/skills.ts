import type { Catalog } from "@emploke/catalog";
import { Hono } from "hono";
import { errorBody, statusForCatalogError } from "../_shared.js";
import { readContentBody, readInstallBody, readMetadataBody } from "./helpers.js";

/**
 * Routes for /api/skills/*. Mounted by `catalogRoutes` at "/skills".
 */
export function skillsRoutes(catalog: Catalog): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(catalog.listSkillEntries()));

  app.get("/:name{.+}", async (c) => {
    const name = c.req.param("name");
    try {
      const entry = catalog.getSkillEntry(name);
      if (!entry) return c.json({ error: "not found", code: "NotFound" }, 404);
      const content = await catalog.getSkillContent(name);
      return c.json({ ...entry, content });
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.post("/", async (c) => {
    const parsed = await readInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const skill = await catalog.installSkill(parsed.sourcePath);
      return c.json(skill, 201);
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
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
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
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
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.delete("/:name{.+}", async (c) => {
    try {
      await catalog.removeSkill(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  return app;
}
