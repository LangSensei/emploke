import { type CatalogManager, deepInstall } from "@emploke/catalog";
import type { FetcherRegistry } from "@emploke/catalog-fetcher";
import { Hono } from "hono";
import { errorBody, statusForCatalogError } from "../_shared.js";
import { readAgentInstallBody, readContentBody, readMetadataBody } from "./helpers.js";
import { type CatalogResolver, resolveCatalog } from "./resolver.js";

/**
 * Routes for /agents/* relative to the parent mount. Mounted by
 * `catalogRoutes` at "/agents". Takes a per-request catalog resolver so
 * the same handler can serve multiple workspaces; tests can also pass a
 * `CatalogManager` instance directly.
 *
 * The `POST /` install handler mirrors {@link skillsRoutes}: takes a body
 * `{ origin: string }`, fetches via the registry, recursively installs
 * declared frontmatter dependencies (skills + mcps; agents never appear
 * as a dep), and returns a `{installed, skipped, failed}` manifest.
 */
export function agentsRoutes(
  arg: CatalogResolver | CatalogManager,
  fetcherRegistry: FetcherRegistry,
): Hono {
  const app = new Hono();
  const getCatalog = resolveCatalog(arg);

  app.get("/", (c) => c.json(getCatalog(c).listAgentEntries()));

  app.get("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      const entry = catalog.getAgentEntry(name);
      if (!entry) return c.json({ error: "not found", code: "NotFound" }, 404);
      const content = await catalog.getAgentContent(name);
      return c.json({ ...entry, content });
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.post("/", async (c) => {
    const catalog = getCatalog(c);
    const parsed = await readAgentInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const manifest = await deepInstall({
        catalog,
        fetchers: fetcherRegistry,
        rootKind: "agent",
        rootOrigin: parsed.origin,
      });
      const status = manifest.failed.length > 0 ? 207 : 201;
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(manifest, status as any);
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.put("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    const parsed = await readContentBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const agent = await catalog.updateAgentContent(name, parsed.content);
      return c.json(agent);
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.patch("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
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
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.delete("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    try {
      await catalog.removeAgent(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  return app;
}
