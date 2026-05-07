import { Hono } from "hono";
import type { Catalog } from "@emploke/catalog";

export function apiRoutes(catalog: Catalog) {
  const api = new Hono();

  // ─── Skills ─────────────────────────────────────────────

  api.get("/skills", (c) => {
    return c.json(catalog.listSkillEntries());
  });

  api.get("/skills/:name{.+}", (c) => {
    const entry = catalog.getSkillEntry(c.req.param("name"));
    if (!entry) return c.json({ error: "not found" }, 404);
    return c.json(entry);
  });

  api.delete("/skills/:name{.+}", async (c) => {
    try {
      await catalog.removeSkill(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ─── Agents ─────────────────────────────────────────────

  api.get("/agents", (c) => {
    return c.json(catalog.listAgentEntries());
  });

  api.get("/agents/:name{.+}", (c) => {
    const entry = catalog.getAgentEntry(c.req.param("name"));
    if (!entry) return c.json({ error: "not found" }, 404);
    return c.json(entry);
  });

  api.delete("/agents/:name{.+}", async (c) => {
    try {
      await catalog.removeAgent(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ─── MCPs ──────────────────────────────────────────────

  api.get("/mcps", (c) => {
    return c.json(catalog.listMcps().map((name) => ({ name, path: catalog.getMcpPath(name) })));
  });

  api.delete("/mcps/:name{.+}", async (c) => {
    try {
      await catalog.removeMcp(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ─── Resolution ─────────────────────────────────────────

  api.get("/resolve/:name{.+}", (c) => {
    try {
      const result = catalog.resolve(c.req.param("name"));
      return c.json(result);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ─── Overview ───────────────────────────────────────────

  api.get("/overview", (c) => {
    const skills = catalog.listSkillEntries();
    const agents = catalog.listAgentEntries();
    const mcps = catalog.listMcps();
    return c.json({
      counts: {
        skills: skills.length,
        agents: agents.length,
        mcps: mcps.length,
        disabled: skills.filter((s) => s.status === "disabled").length +
          agents.filter((a) => a.status === "disabled").length,
      },
      issues: catalog.scanIssues,
    });
  });

  // ─── Rescan ─────────────────────────────────────────────

  api.post("/rescan", async (c) => {
    await catalog.rescan();
    return c.json({ ok: true });
  });

  return api;
}
