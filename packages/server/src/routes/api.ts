import type { Catalog } from "@emploke/catalog";
import { Hono } from "hono";

interface InstallBody {
  sourcePath?: unknown;
  name?: unknown;
}

async function readInstallBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<{ sourcePath: string; name?: string } | { error: string }> {
  let body: InstallBody;
  try {
    body = (await c.req.json()) as InstallBody;
  } catch {
    return { error: "request body must be JSON" };
  }
  if (typeof body.sourcePath !== "string" || body.sourcePath.trim() === "") {
    return { error: "sourcePath is required (string)" };
  }
  const out: { sourcePath: string; name?: string } = { sourcePath: body.sourcePath };
  if (typeof body.name === "string" && body.name.trim() !== "") {
    out.name = body.name;
  }
  return out;
}

export function apiRoutes(catalog: Catalog) {
  const api = new Hono();

  // Refresh in-memory state from disk if it's older than the throttle
  // window. Mutations always update memory synchronously, so this is a
  // best-effort sync to catch external writes (vim, git pull). Throttled
  // (5s by default) so a dashboard mount firing four parallel GETs only
  // triggers one disk scan.
  api.use("/*", async (c, next) => {
    if (c.req.method === "GET") {
      await catalog.rescanIfStale();
    }
    await next();
  });

  // ─── Skills ─────────────────────────────────────────────

  api.get("/skills", (c) => c.json(catalog.listSkillEntries()));

  api.get("/skills/:name{.+}", (c) => {
    const entry = catalog.getSkillEntry(c.req.param("name"));
    if (!entry) return c.json({ error: "not found" }, 404);
    return c.json(entry);
  });

  api.post("/skills", async (c) => {
    const parsed = await readInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const skill = await catalog.installSkill(parsed.sourcePath);
      return c.json(skill, 201);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
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

  api.get("/agents", (c) => c.json(catalog.listAgentEntries()));

  api.get("/agents/:name{.+}", (c) => {
    const entry = catalog.getAgentEntry(c.req.param("name"));
    if (!entry) return c.json({ error: "not found" }, 404);
    return c.json(entry);
  });

  api.post("/agents", async (c) => {
    const parsed = await readInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const agent = await catalog.installAgent(parsed.sourcePath);
      return c.json(agent, 201);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
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

  api.get("/mcps", (c) =>
    c.json(catalog.listMcps().map((name) => ({ name, path: catalog.getMcpPath(name) }))),
  );

  api.get("/mcps/:name{.+}", async (c) => {
    const name = c.req.param("name");
    const path = catalog.getMcpPath(name);
    if (!path) return c.json({ error: "not found" }, 404);
    try {
      const content = await catalog.getMcpContent(name);
      return c.json({ name, path, content });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.post("/mcps", async (c) => {
    const parsed = await readInstallBody(c);
    if ("error" in parsed) return c.json(parsed, 400);
    try {
      const name = await catalog.installMcp(parsed.sourcePath, parsed.name);
      return c.json({ name, path: catalog.getMcpPath(name) }, 201);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.put("/mcps/:name{.+}", async (c) => {
    const name = c.req.param("name");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }
    if (typeof body !== "object" || body === null || !("content" in body)) {
      return c.json({ error: "body must be { content: object }" }, 400);
    }
    try {
      await catalog.updateMcpContent(name, (body as { content: unknown }).content);
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
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
        disabled:
          skills.filter((s) => s.status === "disabled").length +
          agents.filter((a) => a.status === "disabled").length,
      },
      issues: catalog.scanIssues,
    });
  });

  return api;
}
