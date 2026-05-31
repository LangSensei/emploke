import type { CatalogService } from "@emploke/catalog";
import { Hono } from "hono";
import { catalogErrorPolicy } from "../_error-policies/catalog.js";
import { respondError } from "../_respond-error.js";
import { logEvent } from "../_shared.js";
import {
  readAgentInstallBody,
  readContentBody,
  readMetadataBody,
  readPlanTokenBody,
} from "./helpers.js";
import { planToManifest } from "./plan-to-manifest.js";
import { type CatalogResolver, resolveCatalog } from "./resolver.js";

/**
 * Routes for /agents/* relative to the parent mount. Mirrors
 * {@link skillsRoutes}: takes a body `{ origin }`, performs
 * `installAgent` (resolve + apply), returns a `CatalogInstallResult`.
 *
 * `POST /resolve` returns the read-only `CatalogPlan` for the
 * dashboard's two-phase install flow.
 *
 * Status mapping + body shaping flows through `respondError` against
 * `catalogErrorPolicy`. Catalog routes inherit the policy's
 * `defaultStatus: 500` — unknown catalog errors are server faults, not
 * caller-fixable 400s, mirroring the pre-refactor `?? 500` fallback.
 */
export function agentsRoutes(arg: CatalogResolver | CatalogService): Hono {
  const app = new Hono();
  const getCatalog = resolveCatalog(arg);

  app.get("/", async (c) => c.json(await getCatalog(c).listAgentEntries()));

  app.post("/resolve", async (c) => {
    const catalog = getCatalog(c);
    const parsed = await readAgentInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const plan = await catalog.resolveAgentFromOrigin(parsed.origin);
      return c.json(planToManifest(plan));
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.resolve",
        policy: catalogErrorPolicy,
      });
    }
  });

  app.get("/:name{.+}/anchor", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      const content = await catalog.getAgentContent(name);
      return c.json({ content });
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.anchor",
        policy: catalogErrorPolicy,
        meta: { fqn: name },
      });
    }
  });

  app.get("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      const entry = await catalog.getAgentEntry(name);
      if (!entry) return c.json({ error: "not found", code: "NotFound" }, 404);
      const content = await catalog.getAgentContent(name);
      return c.json({ ...entry, content });
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.get",
        policy: catalogErrorPolicy,
        meta: { fqn: name },
      });
    }
  });

  app.post("/", async (c) => {
    const catalog = getCatalog(c);
    const parsed = await readAgentInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const result = await catalog.installAgent(parsed.origin);
      const status = result.failed.length > 0 ? 207 : 201;
      logEvent(c, "catalog: agent install completed", {
        kind: "agent",
        origin: parsed.origin,
        installed: result.installed.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      });
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(result, status as any);
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.install",
        policy: catalogErrorPolicy,
        meta: { origin: parsed.origin },
      });
    }
  });

  app.post("/:name{.+}/sync/resolve", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      // resolveSyncAgent stamps the local origin onto plan.rootOrigin —
      // no second catalog round-trip needed.
      const plan = await catalog.resolveSyncAgent(name);
      const planToken = catalog.cachePlan(plan);
      return c.json(planToManifest(plan, planToken));
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.sync.resolve",
        policy: catalogErrorPolicy,
        meta: { fqn: name },
      });
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
      logEvent(c, "catalog: agent sync applied", {
        kind: "agent",
        installed: result.installed.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      });
      // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a finite union.
      return c.json(result, status as any);
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.sync",
        policy: catalogErrorPolicy,
      });
    }
  });

  app.post("/:name{.+}/acknowledge-prereqs", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      const agent = await catalog.acknowledgeAgentPrereqs(name);
      logEvent(c, "catalog: agent prereqs acknowledged", { kind: "agent", fqn: name });
      return c.json(agent);
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.acknowledgePrereqs",
        policy: catalogErrorPolicy,
        meta: { fqn: name },
      });
    }
  });

  app.post("/:name{.+}/disable", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      const agent = await catalog.disableAgent(name);
      logEvent(c, "catalog: agent disabled", { kind: "agent", fqn: name });
      return c.json(agent);
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.disable",
        policy: catalogErrorPolicy,
        meta: { fqn: name },
      });
    }
  });

  app.post("/:name{.+}/enable", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      const agent = await catalog.enableAgent(name);
      logEvent(c, "catalog: agent enabled", { kind: "agent", fqn: name });
      return c.json(agent);
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.enable",
        policy: catalogErrorPolicy,
        meta: { fqn: name },
      });
    }
  });

  app.put("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    const parsed = await readContentBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const agent = await catalog.updateAgentContent(name, parsed.content);
      logEvent(c, "catalog: agent content updated", { kind: "agent", fqn: name });
      return c.json(agent);
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.updateContent",
        policy: catalogErrorPolicy,
        meta: { fqn: name },
      });
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
      logEvent(c, "catalog: agent metadata updated", { kind: "agent", fqn: name });
      return c.json(agent);
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.updateMetadata",
        policy: catalogErrorPolicy,
        meta: { fqn: name },
      });
    }
  });

  app.delete("/:name{.+}", async (c) => {
    const catalog = getCatalog(c);
    const name = c.req.param("name");
    try {
      await catalog.deleteAgent(name);
      logEvent(c, "catalog: agent removed", { kind: "agent", fqn: name });
      return c.json({ ok: true });
    } catch (err) {
      return respondError(c, err, {
        route: "catalog.agents.delete",
        policy: catalogErrorPolicy,
        meta: { fqn: name },
      });
    }
  });

  return app;
}
