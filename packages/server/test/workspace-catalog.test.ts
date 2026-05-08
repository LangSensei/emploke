import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Catalog } from "@emploke/catalog";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import { type RegistryEntry, WorkspaceManager, WorkspaceRegistry } from "@emploke/workspace";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogRoutes } from "../src/routes/catalog/index.js";
import { WorkspaceContextCache } from "../src/workspace-context.js";

let scratch: string;
let registryFile: string;
let registry: WorkspaceRegistry;
let cache: WorkspaceContextCache;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-cat-"));
  registryFile = path.join(scratch, "workspaces.json");
  registry = await WorkspaceRegistry.open(registryFile);
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotSettingsPath: path.join(scratch, "copilot-settings.json") }),
  );
  cache = new WorkspaceContextCache({ runtimeRegistry, registry });
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function ensureWorkspace(name: string): Promise<RegistryEntry> {
  const dir = path.join(scratch, name);
  await WorkspaceManager.init(dir, { name });
  return registry.add({ path: dir });
}

/**
 * Mounts catalogRoutes under /api/workspaces/:id/catalog/* with the
 * production-shaped middleware so we can exercise the per-workspace flow
 * end-to-end without spinning up the HTTP server.
 */
function mountApp() {
  const app = new Hono<{ Variables: { catalog: Catalog } }>();
  app.use("/api/workspaces/:id/catalog/*", async (c, next) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing workspace id" }, 400);
    const ctx = await cache.get(id);
    if (!ctx) return c.json({ error: "not registered", code: "WorkspaceNotRegisteredError" }, 404);
    c.set("catalog", ctx.catalog);
    await next();
  });
  app.route(
    "/api/workspaces/:id/catalog",
    catalogRoutes((c) => c.get("catalog")),
  );
  return app;
}

describe("workspace-scoped catalog routes", () => {
  it("404 when workspace id is unknown", async () => {
    const app = mountApp();
    const res = await app.request(
      "/api/workspaces/00000000-0000-4000-8000-000000000000/catalog/agents",
    );
    expect(res.status).toBe(404);
  });

  it("GET overview returns zero counts for a fresh workspace", async () => {
    const entry = await ensureWorkspace("alpha");
    const res = await mountApp().request(`/api/workspaces/${entry.id}/catalog/overview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(body.counts).toEqual({ skills: 0, agents: 0, mcps: 0, disabled: 0 });
  });

  it("GET agents/skills/mcps return empty arrays for a fresh workspace", async () => {
    const entry = await ensureWorkspace("alpha");
    const app = mountApp();
    for (const kind of ["agents", "skills", "mcps"]) {
      const res = await app.request(`/api/workspaces/${entry.id}/catalog/${kind}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  });

  it("isolates catalogs between workspaces", async () => {
    const a = await ensureWorkspace("alpha");
    const b = await ensureWorkspace("beta");
    const dirA = a.path;
    const dirB = b.path;

    // Force each workspace to materialise a Catalog so the catalog dir is
    // created with the .lock subdir and any internal state is bootstrapped.
    const ctxA = await cache.get(a.id);
    const ctxB = await cache.get(b.id);
    expect(ctxA).not.toBeNull();
    expect(ctxB).not.toBeNull();
    if (!ctxA || !ctxB) throw new Error("ctx must exist");

    expect(ctxA.catalog).not.toBe(ctxB.catalog);
    expect(ctxA.workspace.catalogDir).toBe(path.join(dirA, "catalog"));
    expect(ctxB.workspace.catalogDir).toBe(path.join(dirB, "catalog"));
  });

  it("memoises catalog per workspace", async () => {
    const entry = await ensureWorkspace("alpha");
    const a1 = await cache.get(entry.id);
    const a2 = await cache.get(entry.id);
    expect(a1).toBe(a2);
    expect(a1?.catalog).toBe(a2?.catalog);
  });
});
