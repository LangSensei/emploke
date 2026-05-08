import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Catalog } from "@emploke/catalog";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import { WorkspaceManager, WorkspaceRegistry } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspacesRoutes } from "../src/routes/workspaces.js";
import { WorkspaceContextCache } from "../src/workspace-context.js";

let scratch: string;
let registryFile: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-ws-"));
  registryFile = path.join(scratch, "workspaces.json");
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const stubCatalog = (): Catalog => ({}) as Catalog;

async function makeApp() {
  const registry = await WorkspaceRegistry.open(registryFile);
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotSettingsPath: path.join(scratch, "copilot-settings.json") }),
  );
  const cache = new WorkspaceContextCache({
    catalog: stubCatalog(),
    runtimeRegistry,
    registry,
  });
  return { app: workspacesRoutes({ registry, cache }), registry };
}

describe("workspacesRoutes - empty registry", () => {
  it("GET / returns []", async () => {
    const { app } = await makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("GET /current returns null", async () => {
    const { app } = await makeApp();
    const res = await app.request("/current");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: null });
  });

  it("PUT /current rejects unknown name", async () => {
    const { app } = await makeApp();
    const res = await app.request("/current", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /:name rejects unknown name", async () => {
    const { app } = await makeApp();
    const res = await app.request("/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("workspacesRoutes - POST /", () => {
  it("creates a workspace and registers it", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "ws1");
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir, name: "ws1" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("ws1");
    expect(body.path).toBe(path.resolve(dir));
    expect(registry.has("ws1")).toBe(true);
    const ws = await WorkspaceManager.open(dir);
    expect(ws.metadata.name).toBe("ws1");
  });

  it("derives name from basename when not provided", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "auto-derived");
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    expect(res.status).toBe(201);
    expect(registry.has("auto-derived")).toBe(true);
  });

  it("rejects missing path", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ws" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate name", async () => {
    const { app } = await makeApp();
    const dir1 = path.join(scratch, "first");
    const dir2 = path.join(scratch, "second");
    const r1 = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir1, name: "shared" }),
    });
    expect(r1.status).toBe(201);
    const r2 = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir2, name: "shared" }),
    });
    expect(r2.status).toBe(409);
  });

  it("returns 400 on invalid name", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(scratch, "x"), name: "Bad Name" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("workspacesRoutes - list/get/current/delete", () => {
  it("GET / lists registered workspaces with metadata when readable", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "alpha" });
    await registry.add({ name: "alpha", path: dir });

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const items = await res.json();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("alpha");
    expect(items[0].status).toBe("ok");
    expect(items[0].metadata.name).toBe("alpha");
  });

  it("GET / surfaces 'missing' status when workspace.json is absent", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "ghost");
    await registry.add({ name: "ghost", path: dir });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const items = await res.json();
    expect(items[0].status).toBe("missing");
  });

  it("GET /:name returns metadata", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "alpha" });
    await registry.add({ name: "alpha", path: dir });

    const res = await app.request("/alpha");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("alpha");
    expect(body.metadata.name).toBe("alpha");
  });

  it("GET /:name returns 404 for unknown name", async () => {
    const { app } = await makeApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });

  it("PUT /current sets the current workspace", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "alpha" });
    await registry.add({ name: "alpha", path: dir });

    const res = await app.request("/current", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alpha" }),
    });
    expect(res.status).toBe(200);
    expect(registry.current()).toBe("alpha");
  });

  it("DELETE /:name removes from registry but leaves files", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "alpha" });
    await registry.add({ name: "alpha", path: dir });

    const res = await app.request("/alpha", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(registry.has("alpha")).toBe(false);
    const ws = await WorkspaceManager.open(dir);
    expect(ws.metadata.name).toBe("alpha");
  });
});
