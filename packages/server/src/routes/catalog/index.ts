import type { Catalog } from "@emploke/catalog";
import { Hono } from "hono";
import { agentsRoutes } from "./agents.js";
import { mcpsRoutes } from "./mcps.js";
import { skillsRoutes } from "./skills.js";

/**
 * Routes for /api/* — catalog resources (skills, agents, mcps) plus an
 * aggregate /overview endpoint. Mounted in `index.ts` at "/api".
 */
export function catalogRoutes(catalog: Catalog): Hono {
  const app = new Hono();

  // Refresh in-memory state from disk if it's older than the throttle
  // window. Mutations always update memory synchronously, so this is a
  // best-effort sync to catch external writes (vim, git pull). Throttled
  // (5s by default) so a dashboard mount firing four parallel GETs only
  // triggers one disk scan. Mounted before sub-routes so it applies to
  // every catalog endpoint.
  app.use("/*", async (c, next) => {
    if (c.req.method === "GET") {
      await catalog.rescanIfStale();
    }
    await next();
  });

  app.route("/skills", skillsRoutes(catalog));
  app.route("/agents", agentsRoutes(catalog));
  app.route("/mcps", mcpsRoutes(catalog));

  app.get("/overview", (c) => {
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
