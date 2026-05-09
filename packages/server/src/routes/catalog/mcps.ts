import { type CatalogManager, deepInstall } from "@emploke/catalog";
import type { FetcherRegistry } from "@emploke/catalog-fetcher";
import { Hono } from "hono";
import { errorBody, statusForCatalogError } from "../_shared.js";
import { readContentBody, readMcpInstallBody } from "./helpers.js";
import { type CatalogResolver, resolveCatalog } from "./resolver.js";

/**
 * Routes for /mcps/* relative to the parent mount. Mounted by
 * `catalogRoutes` at "/mcps".
 *
 * MCPs do not have a metadata PATCH endpoint — they're config-only blobs
 * with no status/disabled state to flip.
 *
 * `POST /` body: `{ origin: string, name: string, scope?: string }`.
 * Unlike skills/agents, the install is non-recursive (MCPs cannot declare
 * dependencies); we still go through `deepInstall` for consistency so the
 * caller always gets a manifest-shaped response.
 */
export function mcpsRoutes(
  arg: CatalogResolver | CatalogManager,
  fetcherRegistry: FetcherRegistry,
): Hono {
  const app = new Hono();
  const getCatalog = resolveCatalog(arg);

  app.get("/", (c) => {
    const catalog = getCatalog(c);
    return c.json(catalog.listMcps().map((name) => ({ name })));
  });

  app.get("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      const content = await catalog.getMcpContent(name);
      return c.json({ name, content });
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.post("/", async (c) => {
    const catalog = getCatalog(c);
    const parsed = await readMcpInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const input: Parameters<typeof deepInstall>[0] = {
        catalog,
        fetchers: fetcherRegistry,
        rootKind: "mcp",
        rootOrigin: parsed.origin,
        rootMcpName: parsed.name,
      };
      if (parsed.scope !== undefined) {
        (input as { rootScope?: string }).rootScope = parsed.scope;
      }
      const manifest = await deepInstall(input);
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
      await catalog.updateMcpContent(name, parsed.content);
      return c.json({ ok: true });
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.delete("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    try {
      await catalog.removeMcp(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  return app;
}
