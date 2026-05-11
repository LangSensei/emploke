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
const openCaches: WorkspaceContextCache[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-ws-"));
  indexFile = path.join(scratch, ".emploke", "workspaces.json");
});
afterEach(async () => {
  for (const c of openCaches.splice(0)) c.closeAll();
  await rm(scratch, { recursive: true, force: true });
});

async function makeApp() {
  const manager = new WorkspaceManager(new FsWorkspaceRepository({ indexFile }));
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(scratch, "copilot-config.json") }),
  );
  const cache = new WorkspaceContextCache({ runtimeRegistry, workspaces: manager });
  openCaches.push(cache);
  // The default workspace parent is per-test-scratch so omitted-workdir
  // requests land somewhere isolated and get cleaned up by afterEach.
  const defaultWorkspaceParent = path.join(scratch, "default-workspaces");
  return {
    app: workspacesRoutes({ manager, cache, defaultWorkspaceParent }),
    manager,
    cache,
    defaultWorkspaceParent,
  };
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

  it("auto-generates a UUID-named workdir under defaultWorkspaceParent when workdir is omitted", async () => {
    const { app, defaultWorkspaceParent } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "no-dir" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; workdir: string };
    expect(body.name).toBe("no-dir");
    // The auto-generated workdir lives under the parent we configured;
    // its basename matches the workspace's UUID — tying the registry id
    // to the on-disk dir name keeps "which folder belongs to which
    // workspace?" answerable without opening workspace.json.
    const expectedPrefix = path.resolve(defaultWorkspaceParent) + path.sep;
    expect(body.workdir.startsWith(expectedPrefix)).toBe(true);
    expect(path.basename(body.workdir)).toBe(body.id);
  });

  it("rejects empty-string workdir (use omission to pick the default)", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "blank-dir", workdir: "   " }),
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

// Issue #30 (slice B): a force-rebuild endpoint for the per-workspace
// `WorkspaceContext` cache so the dashboard can recover from catalog
// drift (user added an agent yaml from outside emploke and the cached
// `CatalogManager` snapshot is stale) without restarting the server.
describe("workspacesRoutes — POST /:id/reload", () => {
  it("returns 204 on cold cache (no entry yet)", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "Cold", workdir: path.join(scratch, "cold") });
    const res = await app.request(`/${ws.id}/reload`, { method: "POST" });
    expect(res.status).toBe(204);
  });

  it("returns 204 and rebuilds the cached context after a warm hit", async () => {
    const { app, manager, cache } = await makeApp();
    const ws = await manager.init({ name: "Warm", workdir: path.join(scratch, "warm") });
    const before = await cache.get(ws.id);
    expect(before).not.toBeNull();
    const res = await app.request(`/${ws.id}/reload`, { method: "POST" });
    expect(res.status).toBe(204);
    const after = await cache.get(ws.id);
    expect(after).not.toBeNull();
    // Identity check: the cache entry must have been replaced, not reused.
    expect(after).not.toBe(before);
  });

  it("returns 404 for an unknown workspace id", async () => {
    const { app } = await makeApp();
    const res = await app.request("/00000000-0000-0000-0000-000000000000/reload", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("WorkspaceNotRegisteredError");
  });

  it("returns 409 with WorkspaceHasLiveTasksError when tasks are live", async () => {
    const { app, manager, cache } = await makeApp();
    const ws = await manager.init({ name: "Live", workdir: path.join(scratch, "live") });
    const ctx = await cache.get(ws.id);
    expect(ctx).not.toBeNull();
    // Spawning a real subprocess just to flip liveCount > 0 would make
    // this test slow + platform-dependent. The contract under test is
    // strictly cache-side ("if the manager reports live > 0, refuse"),
    // so we stub the public counter directly. The real implementation
    // contract (counter > 0 mid-dispatch, back to 0 after exit, back
    // to 0 after rollback) is exercised in
    // `packages/task/test/manager.test.ts` under the `liveCount` describe.
    // biome-ignore lint/suspicious/noExplicitAny: test-only stub.
    (ctx as any).tasks.liveCount = () => 3;

    const res = await app.request(`/${ws.id}/reload`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("WorkspaceHasLiveTasksError");
    expect(body.error).toContain("3 live task");
    // Sanity: the original cached context is preserved (not evicted).
    const stillCached = await cache.get(ws.id);
    expect(stillCached).toBe(ctx);
  });
});
