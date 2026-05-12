import type { CatalogManager } from "@emploke/catalog";
import { Hono } from "hono";
import { errorBody, statusForCatalogError } from "../_shared.js";
import {
  readContentBody,
  readMetadataBody,
  readPlanTokenBody,
  readSkillInstallBody,
} from "./helpers.js";
import { planToManifest } from "./plan-to-manifest.js";
import { type CatalogResolver, resolveCatalog } from "./resolver.js";

/**
 * Routes for /skills/* relative to the parent mount. Mounted by
 * `catalogRoutes` at "/skills".
 *
 * Two endpoints for installs:
 *   - `POST /resolve` — read-only preview (returns CatalogPlan)
 *   - `POST /` — full install (resolve + apply, returns CatalogInstallResult)
 *
 * Dashboard's two-phase flow uses `/resolve` to show the user what
 * will happen, then `/` to commit.
 */
export function skillsRoutes(arg: CatalogResolver | CatalogManager): Hono {
  const app = new Hono();
  const getCatalog = resolveCatalog(arg);

  app.get("/", async (c) => c.json(await getCatalog(c).listSkillEntries()));

  app.post("/resolve", async (c) => {
    const catalog = getCatalog(c);
    const parsed = await readSkillInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const plan = await catalog.resolveSkill(parsed.origin);
      return c.json(planToManifest(plan));
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.get("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      const entry = await catalog.getSkillEntry(name);
      if (!entry) return c.json({ error: "not found", code: "NotFound" }, 404);
      const content = await catalog.getSkillContent(name);
      return c.json({ ...entry, content });
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.post("/", async (c) => {
    const catalog = getCatalog(c);
    const parsed = await readSkillInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const result = await catalog.installSkill(parsed.origin);
      const status = result.failed.length > 0 ? 207 : 201;
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
      // resolveSyncSkill reads the local origin off the row and stamps
      // it onto plan.rootOrigin — no second catalog round-trip needed.
      const plan = await catalog.resolveSyncSkill(name);
      // Cache the plan and ship the token to the dashboard. /sync
      // trades the token back for this exact plan, so apply runs the
      // closure the user previewed (not a fresh resolve that could
      // silently differ).
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
      // Token unknown / already taken / expired → tell the caller to
      // re-preview. 410 Gone matches the "the resource you referenced
      // is no longer available" semantics; PlanTokenInvalid is the
      // single code the dashboard branches on to re-run resolve.
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
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(result, status as any);
    } catch (e: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(errorBody(e), (statusForCatalogError(e) ?? 500) as any);
    }
  });

  app.post("/:name{.+}/acknowledge-prereqs", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      const skill = await catalog.acknowledgeSkillPrereqs(name);
      return c.json(skill);
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
      const skill = await catalog.updateSkillContent(name, parsed.content);
      return c.json(skill);
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
    const catalog = getCatalog(c);
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
