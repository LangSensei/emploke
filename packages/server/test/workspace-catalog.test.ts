import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CatalogManager } from "@emploke/catalog";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import {
  FsWorkspaceRepository,
  type Workspace,
  WorkspaceManager,
  workspaceLayout,
} from "@emploke/workspace";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogRoutes } from "../src/routes/catalog/index.js";
import { WorkspaceContextCache } from "../src/workspace-context.js";

let scratch: string;
let indexFile: string;
let workspaces: WorkspaceManager;
let cache: WorkspaceContextCache;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-cat-"));
  indexFile = path.join(scratch, ".emploke", "workspaces.json");
  workspaces = new WorkspaceManager(new FsWorkspaceRepository({ indexFile }));
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(scratch, "copilot-config.json") }),
  );
  cache = new WorkspaceContextCache({ runtimeRegistry, workspaces });
});
afterEach(async () => {
  cache.closeAll();
  await rm(scratch, { recursive: true, force: true });
});

async function ensureWorkspace(name: string): Promise<Workspace> {
  return workspaces.init({ name, workdir: path.join(scratch, name) });
}

function mountApp() {
  const app = new Hono<{ Variables: { catalog: CatalogManager } }>();
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
    const ws = await ensureWorkspace("alpha");
    const res = await mountApp().request(`/api/workspaces/${ws.id}/catalog/overview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(body.counts).toEqual({ skills: 0, agents: 0, mcps: 0, disabled: 0 });
  });

  it("GET agents/skills/mcps return empty arrays for a fresh workspace", async () => {
    const ws = await ensureWorkspace("alpha");
    const app = mountApp();
    for (const kind of ["agents", "skills", "mcps"]) {
      const res = await app.request(`/api/workspaces/${ws.id}/catalog/${kind}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  });

  it("isolates catalogs between workspaces", async () => {
    const a = await ensureWorkspace("alpha");
    const b = await ensureWorkspace("beta");

    const ctxA = await cache.get(a.id);
    const ctxB = await cache.get(b.id);
    expect(ctxA).not.toBeNull();
    expect(ctxB).not.toBeNull();
    if (!ctxA || !ctxB) throw new Error("ctx must exist");

    expect(ctxA.catalog).not.toBe(ctxB.catalog);
    expect(workspaceLayout(ctxA.workspace.workdir).catalog).toBe(path.join(a.workdir, "catalog"));
    expect(workspaceLayout(ctxB.workspace.workdir).catalog).toBe(path.join(b.workdir, "catalog"));
  });

  it("memoises catalog per workspace", async () => {
    const ws = await ensureWorkspace("alpha");
    const a1 = await cache.get(ws.id);
    const a2 = await cache.get(ws.id);
    expect(a1).toBe(a2);
    expect(a1?.catalog).toBe(a2?.catalog);
  });
});
