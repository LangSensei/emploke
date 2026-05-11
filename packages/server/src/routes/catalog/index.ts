import type { CatalogManager } from "@emploke/catalog";
import { Hono } from "hono";
import { agentsRoutes } from "./agents.js";
import { mcpsRoutes } from "./mcps.js";
import { type CatalogResolver, resolveCatalog } from "./resolver.js";
import { skillsRoutes } from "./skills.js";

/**
 * Workspace-scoped catalog routes. Mounted at
 * `/api/workspaces/:name/catalog/*` in `index.ts`. The routes pull a
 * per-workspace `CatalogManager` instance off the Hono context (set up
 * by the workspace middleware), so handler logic doesn't need to know
 * which workspace is in play.
 *
 * Tests can pass a `CatalogManager` instance directly instead of a
 * resolver. The catalog brings its own `FetcherRegistry` via
 * `CatalogOptions.fetchers` (defaults to `defaultFetcherRegistry`);
 * routes don't need to thread fetchers through.
 */
export function catalogRoutes(arg: CatalogResolver | CatalogManager): Hono {
  const app = new Hono();
  const getCatalog = resolveCatalog(arg);

  app.route("/skills", skillsRoutes(getCatalog));
  app.route("/agents", agentsRoutes(getCatalog));
  app.route("/mcps", mcpsRoutes(getCatalog));

  app.get("/overview", async (c) => {
    const catalog = getCatalog(c);
    const [skills, agents, mcps] = await Promise.all([
      catalog.listSkillEntries(),
      catalog.listAgentEntries(),
      catalog.listMcps(),
    ]);
    return c.json({
      counts: {
        skills: skills.length,
        agents: agents.length,
        mcps: mcps.length,
        blocked:
          skills.filter((s) => s.status === "blocked").length +
          agents.filter((a) => a.status === "blocked").length,
        orphaned:
          skills.filter((s) => s.skill.orphaned).length + mcps.filter((m) => m.orphaned).length,
      },
    });
  });

  return app;
}

export type { CatalogResolver } from "./resolver.js";
