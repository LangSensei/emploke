import type { CatalogManager } from "@emploke/catalog";
import { Hono } from "hono";
import { agentsRoutes } from "./agents.js";
import { mcpsRoutes } from "./mcps.js";
import { type CatalogResolver, resolveCatalog } from "./resolver.js";
import { skillsRoutes } from "./skills.js";

/**
 * Workspace-scoped catalog routes. Mounted at
 * `/api/workspaces/:name/catalog/*` in `index.ts`. The routes pull a
 * per-workspace `CatalogManager` instance off the Hono context (set up by the
 * workspace middleware), so handler logic doesn't need to know which
 * workspace is in play.
 *
 * Tests can pass a `CatalogManager` instance directly instead of a resolver.
 */
export function catalogRoutes(arg: CatalogResolver | CatalogManager): Hono {
  const app = new Hono();
  const getCatalog = resolveCatalog(arg);

  // Refresh in-memory state from disk if it's older than the throttle
  // window. Mutations always update memory synchronously, so this is a
  // best-effort sync to catch external writes (vim, git pull). Throttled
  // (5s by default) so a dashboard mount firing four parallel GETs only
  // triggers one disk scan. Mounted before sub-routes so it applies to
  // every catalog endpoint.
  app.use("/*", async (c, next) => {
    if (c.req.method === "GET") {
      await getCatalog(c).rescanIfStale();
    }
    await next();
  });

  app.route("/skills", skillsRoutes(getCatalog));
  app.route("/agents", agentsRoutes(getCatalog));
  app.route("/mcps", mcpsRoutes(getCatalog));

  app.get("/overview", (c) => {
    const catalog = getCatalog(c);
    const skills = catalog.listSkillEntries();
    const agents = catalog.listAgentEntries();
    const mcps = catalog.listMcps();
    return c.json({
      counts: {
        skills: skills.length,
        agents: agents.length,
        mcps: mcps.length,
        disabled:
          skills.filter((s) => s.status === "disabled").length +
          agents.filter((a) => a.status === "disabled").length,
      },
      issues: catalog.scanIssues,
    });
  });

  return app;
}

export type { CatalogResolver } from "./resolver.js";
