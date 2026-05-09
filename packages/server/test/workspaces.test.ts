import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import { FsWorkspaceRepository, WorkspaceManager } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspacesRoutes } from "../src/routes/workspaces.js";
import { WorkspaceContextCache } from "../src/workspace-context.js";

let scratch: string;
let indexFile: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-ws-"));
  indexFile = path.join(scratch, ".emploke", "workspaces.json");
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function makeApp() {
  const manager = new WorkspaceManager(new FsWorkspaceRepository({ indexFile }));
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(scratch, "copilot-config.json") }),
  );
  const cache = new WorkspaceContextCache({ runtimeRegistry, workspaces: manager });
  return { app: workspacesRoutes({ manager, cache }), manager };
}

describe("workspacesRoutes — empty registry", () => {
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

  it("DELETE /:id is idempotent for unknown id (204)", async () => {
    const { app } = await makeApp();
    const res = await app.request("/22222222-2222-4222-8222-222222222222", { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});

describe("workspacesRoutes — POST /", () => {
  it("creates a workspace with a generated UUID and registers it", async () => {
    const { app, manager } = await makeApp();
    const wsDir = path.join(scratch, "ws1");
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workdir: wsDir, name: "Workspace One" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; workdir: string };
    expect(body.name).toBe("Workspace One");
    expect(body.workdir).toBe(path.resolve(wsDir));
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await manager.read(body.id)).not.toBeNull();
  });

  it("rejects missing name", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workdir: path.join(scratch, "ws2") }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing workdir", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "no-dir" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate workdir", async () => {
    const { app } = await makeApp();
    const wsDir = path.join(scratch, "ws-dup");
    const post = async () =>
      app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workdir: wsDir, name: "Dup" }),
      });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(409);
  });

  it("returns 400 on empty display name", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workdir: path.join(scratch, "ws-empty"), name: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts unicode display names", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workdir: path.join(scratch, "ws-unicode"), name: "工作区 1" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("工作区 1");
  });
});

describe("workspacesRoutes — list / get / current / delete", () => {
  it("GET / lists registered workspaces", async () => {
    const { app, manager } = await makeApp();
    await manager.init({ name: "A", workdir: path.join(scratch, "a") });
    await manager.init({ name: "B", workdir: path.join(scratch, "b") });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string }[];
    expect(body.map((b) => b.name).sort()).toEqual(["A", "B"]);
  });

  it("GET /:id returns the workspace", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "Hello", workdir: path.join(scratch, "h") });
    const res = await app.request(`/${ws.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe(ws.id);
    expect(body.name).toBe("Hello");
  });

  it("GET /:id returns 404 for unknown id", async () => {
    const { app } = await makeApp();
    const res = await app.request("/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("PUT /current sets the current workspace", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "Cur", workdir: path.join(scratch, "cur") });
    const res = await app.request("/current", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ws.id }),
    });
    expect(res.status).toBe(200);
    expect(await manager.getCurrent()).toBe(ws.id);
  });

  it("DELETE /:id default removes only metadata; user files preserved", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "Del", workdir: path.join(scratch, "del") });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(ws.workdir, "user-file.txt"), "user", "utf8");
    const res = await app.request(`/${ws.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await manager.read(ws.id)).toBeNull();
    expect(await fs.readFile(path.join(ws.workdir, "user-file.txt"), "utf8")).toBe("user");
  });

  it("DELETE /:id?purge=1 also removes emploke-owned subdirs", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "Purge", workdir: path.join(scratch, "purge") });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(ws.workdir, "user-file.txt"), "user", "utf8");
    await fs.writeFile(path.join(ws.workdir, "sessions", "drop.txt"), "agent", "utf8");

    const res = await app.request(`/${ws.id}?purge=1`, { method: "DELETE" });
    expect(res.status).toBe(204);
    await expect(fs.stat(path.join(ws.workdir, "sessions"))).rejects.toThrow();
    expect(await fs.readFile(path.join(ws.workdir, "user-file.txt"), "utf8")).toBe("user");
  });
});

describe("workspacesRoutes — PATCH /:id", () => {
  it("renames the display name", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "Old", workdir: path.join(scratch, "x") });
    const res = await app.request(`/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("New");
    const wsFile = path.join(ws.workdir, "workspace.json");
    const stored = JSON.parse(await readFile(wsFile, "utf8"));
    expect(stored.name).toBe("New");
  });

  it("returns 400 when no patchable fields are present", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "X", workdir: path.join(scratch, "y") });
    const res = await app.request(`/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on empty display name", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "X", workdir: path.join(scratch, "z") });
    const res = await app.request(`/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown id", async () => {
    const { app } = await makeApp();
    const res = await app.request("/00000000-0000-0000-0000-000000000000", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "anything" }),
    });
    expect(res.status).toBe(404);
  });
});
