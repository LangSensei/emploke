import type { CatalogManager } from "@emploke/catalog";
import type { EntryFile, FetcherRegistry } from "@emploke/catalog-fetcher";
import { Hono } from "hono";
import { errorBody, statusForCatalogError } from "../_shared.js";
import { readContentBody, readMcpInstallBody } from "./helpers.js";
import { type CatalogResolver, resolveCatalog } from "./resolver.js";

/**
 * Routes for /mcps/* relative to the parent mount. Mounted by
 * `catalogRoutes` at "/mcps".
 *
 * `POST /` body: `{ origin: string, name: string }`. The `name` is the
 * full MCP-spec FQN (`<namespace>/<short>`, e.g. `azure/mcp`). MCPs
 * have no deps, so the install is a single fetch + write — we
 * deliberately bypass the resolve/apply orchestration the skill/agent
 * routes use.
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
      const stream = fetcherRegistry.dispatch(parsed.origin);
      const content = await readSingleFile(stream);
      const fqn = await catalog.installMcp(content, {
        name: parsed.name,
        origin: parsed.origin,
      });
      return c.json({ name: fqn, origin: parsed.origin }, 201);
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

async function readSingleFile(stream: AsyncIterable<EntryFile>): Promise<string> {
  let result: Buffer | null = null;
  for await (const file of stream) {
    if (result === null) result = file.content;
  }
  if (result === null) throw new Error("stream yielded no files (expected one for mcp install)");
  return result.toString("utf8");
}
