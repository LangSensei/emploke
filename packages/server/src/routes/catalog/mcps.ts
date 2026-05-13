import type { CatalogManager } from "@emploke/catalog";
import { Hono } from "hono";
import { errorBody, logEvent, statusForCatalogError } from "../_shared.js";
import { readContentBody, readMcpInstallBody, readPlanTokenBody } from "./helpers.js";
import { planToManifest } from "./plan-to-manifest.js";
import { type CatalogResolver, resolveCatalog } from "./resolver.js";

/**
 * Routes for /mcps/* relative to the parent mount. Mounted by
 * `catalogRoutes` at "/mcps".
 *
 * `POST /` body: `{ origin: string, name: string }`. The `name` is the
 * full MCP-spec FQN (`<namespace>/<short>`, e.g. `azure/mcp`). MCPs
 * have no deps, so the install is a single fetch + write.
 */
export function mcpsRoutes(arg: CatalogResolver | CatalogManager): Hono {
  const app = new Hono();
  const getCatalog = resolveCatalog(arg);

  app.get("/", async (c) => {
    const catalog = getCatalog(c);
    // listMcps() already returns McpMetadata[] (`{ name, origin, mutable }`)
    // — return as-is. The dashboard's `McpItem` is the same shape. The
    // previous `.map((name) => ({ name }))` was a leftover from the
    // pre-PR-#52 catalog where `listMcps()` returned `string[]`; against
    // the new metadata shape it produced `{ name: { name, origin, mutable } }`
    // and crashed the dashboard's React render with "Objects are not
    // valid as a React child".
    return c.json(await catalog.listMcps());
  });

  app.get("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      const meta = await catalog.getMcp(name);
      if (meta === null) return c.json({ error: "not found", code: "NotFound" }, 404);
      const content = await catalog.getMcpContent(name);
      return c.json({ ...meta, content });
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
      const result = await catalog.installMcpFromOrigin(parsed.origin);
      const status = result.failed.length > 0 ? 207 : 201;
      logEvent(c, "catalog: mcp install completed", {
        kind: "mcp",
        origin: parsed.origin,
        installed: result.installed.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      });
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(result, status as any);
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.post("/:name{.+}/sync/resolve", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      // resolveSyncMcp stamps the local origin onto plan.rootOrigin —
      // no second catalog round-trip needed.
      const plan = await catalog.resolveSyncMcp(name);
      const planToken = catalog.cachePlan(plan);
      return c.json(planToManifest(plan, planToken));
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.post("/:name{.+}/sync", async (c) => {
    const catalog = getCatalog(c);
    const parsed = await readPlanTokenBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    const plan = catalog.takePlan(parsed.planToken);
    if (plan === null) {
      return c.json(
        {
          error: "preview expired or already applied; re-preview to continue",
          code: "PlanTokenInvalid",
        },
        410,
      );
    }
    try {
      const result = await catalog.applySync(plan);
      const status = result.failed.length > 0 ? 207 : 200;
      logEvent(c, "catalog: mcp sync applied", {
        kind: "mcp",
        installed: result.installed.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      });
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(result, status as any);
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
      logEvent(c, "catalog: mcp content updated", { kind: "mcp", fqn: name });
      return c.json({ ok: true });
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.delete("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      await catalog.deleteMcp(name);
      logEvent(c, "catalog: mcp removed", { kind: "mcp", fqn: name });
      return c.json({ ok: true });
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  return app;
}
