import type { CatalogService } from "@emploke/catalog";
import { Hono } from "hono";
import { agentsRoutes } from "./agents.js";
import { mcpsRoutes } from "./mcps.js";
import { type CatalogResolver, resolveCatalog } from "./resolver.js";
import { skillsRoutes } from "./skills.js";

/**
 * Workspace-scoped catalog routes. The routes pull a per-workspace
 * `CatalogService` ({@link CatalogService} writes + {@link CatalogService}
 * reads) off the Hono context, set up by the workspace middleware.
 *
 * Tests can pass a `CatalogService` directly. The catalog brings its
 * own `FetcherRegistry` via `CatalogOptions.fetchers`; routes don't
 * thread fetchers through.
 */
export function catalogRoutes(arg: CatalogResolver | CatalogService): Hono {
  const app = new Hono();
  const getCatalog = resolveCatalog(arg);

  app.route("/skills", skillsRoutes(getCatalog));
  app.route("/agents", agentsRoutes(getCatalog));
  app.route("/mcps", mcpsRoutes(getCatalog));

  app.get("/overview", async (c) => {
    const queries = getCatalog(c);
    const [skills, agents, mcps] = await Promise.all([
      queries.listSkillEntries(),
      queries.listAgentEntries(),
      queries.listMcps(),
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
