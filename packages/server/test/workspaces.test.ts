import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkspaceService } from "@emploke/workspace";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestId } from "../src/middleware/request-id.js";
import { requestLogger } from "../src/middleware/request-logger.js";
import { workspacesRoutes } from "../src/routes/workspaces.js";
import { captureLogger } from "./_capture-logger.js";
import {
  type ServerTestSubsystem,
  setupTestSubsystem,
  teardownTestSubsystem,
} from "./_test-support.js";

let scratch: string;
const openSubsystems: ServerTestSubsystem[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-ws-"));
});
afterEach(async () => {
  for (const sys of openSubsystems.splice(0)) {
    await teardownTestSubsystem(sys);
  }
  await rm(scratch, { recursive: true, force: true });
});

async function makeApp() {
  const sys = await setupTestSubsystem({ scratch });
  openSubsystems.push(sys);
  return {
    app: workspacesRoutes({
      service: sys.service,
      queries: sys.queries,
      cache: sys.cache,
      defaultWorkspaceParent: sys.defaultWorkspaceParent,
    }),
    service: sys.service,
    queries: sys.queries,
    cache: sys.cache,
    defaultWorkspaceParent: sys.defaultWorkspaceParent,
  };
}

async function register(
  service: WorkspaceService,
  args: { id?: string; workspaceDir: string; name: string },
): Promise<string> {
  const id = args.id ?? (await import("node:crypto")).randomUUID();
  const result = await service.register({
    id,
    workspaceDir: args.workspaceDir,
    name: args.name,
  });
  return result.id;
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
    const { app, queries } = await makeApp();
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
    expect(await queries.getById(body.id)).not.toBeNull();
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
    const { app, service } = await makeApp();
    await register(service, { name: "A", workspaceDir: path.join(scratch, "a") });
    await register(service, { name: "B", workspaceDir: path.join(scratch, "b") });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string }[];
    expect(body.map((b) => b.name).sort()).toEqual(["A", "B"]);
  });

  it("GET /:id returns the workspace", async () => {
    const { app, service } = await makeApp();
    const id = await register(service, { name: "Hello", workspaceDir: path.join(scratch, "h") });
    const res = await app.request(`/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe(id);
    expect(body.name).toBe("Hello");
  });

  it("GET /:id returns 404 for unknown id", async () => {
    const { app } = await makeApp();
    const res = await app.request("/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("PUT /current sets the current workspace", async () => {
    const { app, service, queries } = await makeApp();
    const id = await register(service, { name: "Cur", workspaceDir: path.join(scratch, "cur") });
    const res = await app.request("/current", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    expect(res.status).toBe(200);
    expect(await queries.getLastOpenedId()).toBe(id);
  });

  it("DELETE /:id default removes only metadata; user files preserved", async () => {
    const { app, service, queries } = await makeApp();
    const workspaceDir = path.join(scratch, "del");
    const id = await register(service, { name: "Del", workspaceDir });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(workspaceDir, "user-file.txt"), "user", "utf8");
    const res = await app.request(`/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await queries.getById(id)).toBeNull();
    expect(await fs.readFile(path.join(workspaceDir, "user-file.txt"), "utf8")).toBe("user");
  });

  it("DELETE /:id?purge=1 also removes emploke-owned subdirs", async () => {
    const { app, service } = await makeApp();
    const workspaceDir = path.join(scratch, "purge");
    const id = await register(service, { name: "Purge", workspaceDir });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(workspaceDir, "user-file.txt"), "user", "utf8");
    await fs.writeFile(path.join(workspaceDir, "sessions", "drop.txt"), "agent", "utf8");

    const res = await app.request(`/${id}?purge=1`, { method: "DELETE" });
    expect(res.status).toBe(204);
    await expect(fs.stat(path.join(workspaceDir, "sessions"))).rejects.toThrow();
    expect(await fs.readFile(path.join(workspaceDir, "user-file.txt"), "utf8")).toBe("user");
  });
});

describe("workspacesRoutes — PATCH /:id", () => {
  it("renames the display name", async () => {
    const { app, service, queries } = await makeApp();
    const id = await register(service, { name: "Old", workspaceDir: path.join(scratch, "x") });
    const res = await app.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("New");
    const stored = await queries.getById(id);
    expect(stored?.name).toBe("New");
  });

  it("returns 400 when no patchable fields are present", async () => {
    const { app, service } = await makeApp();
    const id = await register(service, { name: "X", workspaceDir: path.join(scratch, "y") });
    const res = await app.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on empty display name", async () => {
    const { app, service } = await makeApp();
    const id = await register(service, { name: "X", workspaceDir: path.join(scratch, "z") });
    const res = await app.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    // Validation error from the value-object factory is mapped to 500
    // by the catch-all (WorkspaceNameInvalidError → 400 in the
    // error-status map, but PATCH wraps it with `wsErrorJson(err,
    // 500)` fallback). The mapped status comes back as 400 because
    // the typed error class is in the lookup.
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown id (and does not re-create the workspace)", async () => {
    const { app, queries } = await makeApp();
    const id = "00000000-0000-0000-0000-000000000000";
    const res = await app.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "anything" }),
    });
    expect(res.status).toBe(404);
    // Strict-update semantics: the rename atomically fails — no row
    // ever appeared.
    expect(await queries.getById(id)).toBeNull();
  });
});

// Issue #30 (slice B): a force-rebuild endpoint for the per-workspace
// container cache so the dashboard can recover from catalog drift
// (user added an agent yaml from outside emploke and the cached
// `CatalogManager` snapshot is stale) without restarting the server.
describe("workspacesRoutes — POST /:id/reload", () => {
  it("returns 204 on cold cache (no entry yet)", async () => {
    const { app, service } = await makeApp();
    const id = await register(service, { name: "Cold", workspaceDir: path.join(scratch, "cold") });
    const res = await app.request(`/${id}/reload`, { method: "POST" });
    expect(res.status).toBe(204);
  });

  it("returns 204 and rebuilds the cached container after a warm hit", async () => {
    const { app, service, cache } = await makeApp();
    const id = await register(service, { name: "Warm", workspaceDir: path.join(scratch, "warm") });
    const before = await cache.get(id);
    expect(before).not.toBeNull();
    const res = await app.request(`/${id}/reload`, { method: "POST" });
    expect(res.status).toBe(204);
    const after = await cache.get(id);
    expect(after).not.toBeNull();
    // Identity check: the cache entry must have been replaced.
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
    const { app, service, cache } = await makeApp();
    const id = await register(service, { name: "Live", workspaceDir: path.join(scratch, "live") });
    const ctx = await cache.get(id);
    expect(ctx).not.toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: test-only stub.
    (ctx as any).tasks.liveCount = () => 3;

    const res = await app.request(`/${id}/reload`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("WorkspaceHasLiveTasksError");
    expect(body.error).toContain("3 live task");
    const stillCached = await cache.get(id);
    expect(stillCached).toBe(ctx);
  });
});

// Issue #58 (slice 2): every state-mutating workspace endpoint emits a
// single structured `info` line at the success boundary.
describe("workspacesRoutes — observability (issue #58)", () => {
  async function makeWiredApp() {
    const cap = captureLogger();
    const sys = await setupTestSubsystem({ scratch, logger: cap.logger });
    openSubsystems.push(sys);

    const root = new Hono();
    root.use("*", requestId());
    root.use("*", requestLogger(cap.logger));
    root.route(
      "/",
      workspacesRoutes({
        service: sys.service,
        queries: sys.queries,
        cache: sys.cache,
        defaultWorkspaceParent: sys.defaultWorkspaceParent,
      }),
    );

    return {
      root,
      cap,
      service: sys.service,
      queries: sys.queries,
      cache: sys.cache,
    };
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
    const { root, cap, service } = await makeWiredApp();
    const id = await register(service, {
      name: "Doomed",
      workspaceDir: path.join(scratch, "doomed"),
    });
    cap.entries.length = 0;

    const res = await root.request(`/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const evt = cap.entries.find((e) => e.msg === "workspace deleted");
    expect(evt?.workspaceId).toBe(id);
  });
});
