import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

async function makeApp() {
  const registry = await WorkspaceRegistry.open(registryFile);
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotSettingsPath: path.join(scratch, "copilot-settings.json") }),
  );
  const cache = new WorkspaceContextCache({ runtimeRegistry, registry });
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
    expect(await res.json()).toEqual({ id: null });
  });

  it("PUT /current rejects unknown id", async () => {
    const { app } = await makeApp();
    const res = await app.request("/current", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /:id rejects unknown id", async () => {
    const { app } = await makeApp();
    const res = await app.request("/22222222-2222-4222-8222-222222222222", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("workspacesRoutes - POST /", () => {
  it("creates a workspace with a generated UUID and registers it", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "ws1");
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir, name: "Workspace One" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("string");
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.path).toBe(path.resolve(dir));
    expect(body.metadata.name).toBe("Workspace One");
    expect(registry.has(body.id)).toBe(true);
    const ws = await WorkspaceManager.open(dir);
    expect(ws.metadata.name).toBe("Workspace One");
  });

  it("rejects missing name", async () => {
    const { app } = await makeApp();
    const dir = path.join(scratch, "no-name");
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    expect(res.status).toBe(400);
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

  it("returns 409 on duplicate path", async () => {
    const { app } = await makeApp();
    const dir = path.join(scratch, "shared");
    const r1 = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir, name: "First" }),
    });
    expect(r1.status).toBe(201);
    const r2 = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir, name: "Second" }),
    });
    expect(r2.status).toBe(409);
  });

  it("returns 400 on empty display name", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(scratch, "x"), name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts unicode display names", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "uni");
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir, name: "工作区 " }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.metadata.name).toBe("工作区 ");
    expect(registry.has(body.id)).toBe(true);
  });
});

describe("workspacesRoutes - list/get/current/delete", () => {
  it("GET / lists registered workspaces with metadata when readable", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "Alpha" });
    const entry = await registry.add({ path: dir });

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const items = await res.json();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(entry.id);
    expect(items[0].status).toBe("ok");
    expect(items[0].metadata.name).toBe("Alpha");
  });

  it("GET / surfaces 'missing' status when workspace.json is absent", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "ghost");
    await registry.add({ path: dir });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const items = await res.json();
    expect(items[0].status).toBe("missing");
  });

  it("GET /:id returns metadata", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "Alpha" });
    const entry = await registry.add({ path: dir });

    const res = await app.request(`/${entry.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(entry.id);
    expect(body.metadata.name).toBe("Alpha");
  });

  it("GET /:id returns 404 for unknown id", async () => {
    const { app } = await makeApp();
    const res = await app.request("/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });

  it("PUT /current sets the current workspace", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "Alpha" });
    const entry = await registry.add({ path: dir });

    const res = await app.request("/current", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: entry.id }),
    });
    expect(res.status).toBe(200);
    expect(registry.current()).toBe(entry.id);
  });

  it("DELETE /:id removes from registry but leaves files", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "Alpha" });
    const entry = await registry.add({ path: dir });

    const res = await app.request(`/${entry.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(registry.has(entry.id)).toBe(false);
    const ws = await WorkspaceManager.open(dir);
    expect(ws.metadata.name).toBe("Alpha");
  });
});

describe("workspacesRoutes - PATCH /:id", () => {
  it("renames the display name in workspace.json", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "Alpha" });
    const entry = await registry.add({ path: dir });

    const res = await app.request(`/${entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed Alpha" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Id is opaque and stable.
    expect(body.id).toBe(entry.id);
    expect(body.metadata.name).toBe("Renamed Alpha");

    const ws = await WorkspaceManager.open(dir);
    expect(ws.metadata.name).toBe("Renamed Alpha");
  });

  it("returns 400 when no patchable fields are present", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "Alpha" });
    const entry = await registry.add({ path: dir });

    const res = await app.request(`/${entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on empty display name", async () => {
    const { app, registry } = await makeApp();
    const dir = path.join(scratch, "alpha");
    await WorkspaceManager.init(dir, { name: "Alpha" });
    const entry = await registry.add({ path: dir });

    const res = await app.request(`/${entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown id", async () => {
    const { app } = await makeApp();
    const res = await app.request("/00000000-0000-4000-8000-000000000000", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Anything" }),
    });
    expect(res.status).toBe(404);
  });
});
