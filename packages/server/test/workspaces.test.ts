import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { captureLogger } from "@emploke/logger/testing";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import {
  runPkgMigrations,
  SqliteWorkspaceRepository,
  WORKSPACE_MIGRATIONS,
  WorkspaceManager,
} from "@emploke/workspace";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestId } from "../src/middleware/request-id.js";
import { requestLogger } from "../src/middleware/request-logger.js";
import { workspacesRoutes } from "../src/routes/workspaces.js";
import { WorkspaceContextCache } from "../src/workspace-context.js";

let scratch: string;
let globalDb: DatabaseSync;
const openCaches: WorkspaceContextCache[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-ws-"));
  globalDb = new DatabaseSync(":memory:");
  await runPkgMigrations(globalDb, [{ pkg: "workspace", migrations: WORKSPACE_MIGRATIONS }]);
});
afterEach(async () => {
  for (const c of openCaches.splice(0)) c.closeAll();
  try {
    globalDb.close();
  } catch {
    // already closed
  }
  await rm(scratch, { recursive: true, force: true });
});

async function makeApp() {
  const manager = new WorkspaceManager(new SqliteWorkspaceRepository({ db: globalDb }));
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(scratch, "copilot-config.json") }),
  );
  const cache = new WorkspaceContextCache({ runtimeRegistry, workspaces: manager });
  openCaches.push(cache);
  // The default workspace parent is per-test-scratch so omitted-workspaceDir
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
      body: JSON.stringify({ workspaceDir: wsDir, name: "Workspace One" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; workspaceDir: string };
    expect(body.name).toBe("Workspace One");
    expect(body.workspaceDir).toBe(path.resolve(wsDir));
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await manager.read(body.id)).not.toBeNull();
  });

  it("rejects missing name", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceDir: path.join(scratch, "ws2") }),
    });
    expect(res.status).toBe(400);
  });

  it("auto-generates a UUID-named workspaceDir under defaultWorkspaceParent when omitted", async () => {
    const { app, defaultWorkspaceParent } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "no-dir" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; workspaceDir: string };
    expect(body.name).toBe("no-dir");
    // The auto-generated workspaceDir lives under the parent we
    // configured; its basename matches the workspace's UUID — tying the
    // registry id to the on-disk dir name keeps "which folder belongs
    // to which workspace?" answerable from the path alone.
    const expectedPrefix = path.resolve(defaultWorkspaceParent) + path.sep;
    expect(body.workspaceDir.startsWith(expectedPrefix)).toBe(true);
    expect(path.basename(body.workspaceDir)).toBe(body.id);
  });

  it("rejects empty-string workspaceDir (use omission to pick the default)", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "blank-dir", workspaceDir: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate workspaceDir", async () => {
    const { app } = await makeApp();
    const wsDir = path.join(scratch, "ws-dup");
    const post = async () =>
      app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceDir: wsDir, name: "Dup" }),
      });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(409);
  });

  it("returns 400 on empty display name", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceDir: path.join(scratch, "ws-empty"), name: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts unicode display names", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceDir: path.join(scratch, "ws-unicode"), name: "工作区 1" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("工作区 1");
  });

  it("silently drops the legacy `workdir` + `defaults` fields (wire break, issue #121)", async () => {
    // Pre-v2 callers used `workdir` and `defaults` on the create body.
    // Both are gone in v2; the server doesn't 400, it just ignores
    // them. The fresh workspace ends up with an auto-allocated
    // workspaceDir because the new field is absent.
    const { app, defaultWorkspaceParent } = await makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "legacy-shape",
        workdir: path.join(scratch, "would-have-been-here"),
        defaults: { runtime: "gemini" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(
      (body as { workspaceDir: string }).workspaceDir.startsWith(
        path.resolve(defaultWorkspaceParent) + path.sep,
      ),
    ).toBe(true);
    expect(body.defaults).toBeUndefined();
    expect(body.workdir).toBeUndefined();
  });
});

describe("workspacesRoutes — list / get / current / delete", () => {
  it("GET / lists registered workspaces", async () => {
    const { app, manager } = await makeApp();
    await manager.init({ name: "A", workspaceDir: path.join(scratch, "a") });
    await manager.init({ name: "B", workspaceDir: path.join(scratch, "b") });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string }[];
    expect(body.map((b) => b.name).sort()).toEqual(["A", "B"]);
  });

  it("GET /:id returns the workspace", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "Hello", workspaceDir: path.join(scratch, "h") });
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
    const ws = await manager.init({ name: "Cur", workspaceDir: path.join(scratch, "cur") });
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
    const ws = await manager.init({ name: "Del", workspaceDir: path.join(scratch, "del") });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(ws.workspaceDir, "user-file.txt"), "user", "utf8");
    const res = await app.request(`/${ws.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await manager.read(ws.id)).toBeNull();
    expect(await fs.readFile(path.join(ws.workspaceDir, "user-file.txt"), "utf8")).toBe("user");
  });

  it("DELETE /:id?purge=1 also removes emploke-owned subdirs", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "Purge", workspaceDir: path.join(scratch, "purge") });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(ws.workspaceDir, "user-file.txt"), "user", "utf8");
    await fs.writeFile(path.join(ws.workspaceDir, "sessions", "drop.txt"), "agent", "utf8");

    const res = await app.request(`/${ws.id}?purge=1`, { method: "DELETE" });
    expect(res.status).toBe(204);
    await expect(fs.stat(path.join(ws.workspaceDir, "sessions"))).rejects.toThrow();
    expect(await fs.readFile(path.join(ws.workspaceDir, "user-file.txt"), "utf8")).toBe("user");
  });
});

describe("workspacesRoutes — PATCH /:id", () => {
  it("renames the display name", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "Old", workspaceDir: path.join(scratch, "x") });
    const res = await app.request(`/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("New");
    // Re-read via the manager — it round-trips through SQLite, no
    // workspace.json sidecar exists since the global.db consolidation.
    const stored = await manager.read(ws.id);
    expect(stored?.name).toBe("New");
  });

  it("returns 400 when no patchable fields are present", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "X", workspaceDir: path.join(scratch, "y") });
    const res = await app.request(`/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on empty display name", async () => {
    const { app, manager } = await makeApp();
    const ws = await manager.init({ name: "X", workspaceDir: path.join(scratch, "z") });
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
    const ws = await manager.init({ name: "Cold", workspaceDir: path.join(scratch, "cold") });
    const res = await app.request(`/${ws.id}/reload`, { method: "POST" });
    expect(res.status).toBe(204);
  });

  it("returns 204 and rebuilds the cached context after a warm hit", async () => {
    const { app, manager, cache } = await makeApp();
    const ws = await manager.init({ name: "Warm", workspaceDir: path.join(scratch, "warm") });
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
    const ws = await manager.init({ name: "Live", workspaceDir: path.join(scratch, "live") });
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

// Issue #58 (slice 2): every state-mutating workspace endpoint emits a
// single structured `info` line at the success boundary so operators
// can audit who changed what without parsing free-form messages. The
// info lines flow through the request-scoped logger that the
// `requestLogger` middleware binds, so they inherit the request id.
describe("workspacesRoutes — observability (issue #58)", () => {
  async function makeWiredApp() {
    const cap = captureLogger();
    const manager = new WorkspaceManager(new SqliteWorkspaceRepository({ db: globalDb }));
    const runtimeRegistry = new RuntimeRegistry();
    runtimeRegistry.register(
      new CopilotRuntime({ copilotConfigPath: path.join(scratch, "copilot-config.json") }),
    );
    const cache = new WorkspaceContextCache({ runtimeRegistry, workspaces: manager });
    openCaches.push(cache);
    const defaultWorkspaceParent = path.join(scratch, "default-workspaces");

    // Wire the middleware chain that production mounts in app.ts:
    // requestId then requestLogger so c.var.logger is a request-scoped
    // child carrying the request id. workspacesRoutes is mounted at
    // root for the test, but the helper would behave identically under
    // any mount path.
    const root = new Hono();
    root.use("*", requestId());
    root.use("*", requestLogger(cap.logger));
    root.route("/", workspacesRoutes({ manager, cache, defaultWorkspaceParent }));

    return { root, cap, manager, cache };
  }

  it("POST / emits a 'workspace created' info line carrying the new id", async () => {
    const { root, cap } = await makeWiredApp();
    const res = await root.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-create" },
      body: JSON.stringify({ workspaceDir: path.join(scratch, "obs-create"), name: "Obs Create" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    const evt = cap.entries.find((e) => e.msg === "workspace created");
    expect(evt).toBeDefined();
    expect(evt?.level).toBe(30); // info
    expect(evt?.workspaceId).toBe(body.id);
    expect(evt?.requestId).toBe("req-create");
  });

  it("DELETE /:id emits a 'workspace deleted' info line", async () => {
    const { root, cap, manager } = await makeWiredApp();
    const ws = await manager.init({ name: "Doomed", workspaceDir: path.join(scratch, "doomed") });
    cap.entries.length = 0;

    const res = await root.request(`/${ws.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const evt = cap.entries.find((e) => e.msg === "workspace deleted");
    expect(evt?.workspaceId).toBe(ws.id);
  });
});
