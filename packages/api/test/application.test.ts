/**
 * Tests for `@emploke/api`. Coverage is focused on the orchestration
 * surface (`Application`) and the per-workspace context registry
 * lifecycle invariants the package owns:
 *
 *   - composeApplication rejects misconfiguration (relative
 *     defaultWorkspaceParent)
 *   - registerWorkspace mints a uuid, defaults the dir, persists
 *   - unregisterWorkspace + renameWorkspace invalidate the per-workspace
 *     context
 *   - Application.getContext dedupes concurrent loads via the internal
 *     registry's inflight map
 *   - Application.reloadWorkspace refuses when live tasks exist and
 *     drains inflight loads
 *
 * Tests use real composeWorkspaceModule against `:memory:` plus a
 * minimal stub Runtime registered through the real RuntimeRegistry so
 * composeSessionModule / composeTaskModule succeed.
 *
 * Registry-internal race semantics (closeAll drain, partial load
 * rollback) are pinned in `workspace-context.test.ts`, which imports
 * `WorkspaceContextRegistry` via a relative path.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Runtime, RuntimeCapabilities } from "@emploke/runtime";
import { RuntimeRegistry } from "@emploke/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Application, composeApplication, WorkspaceHasLiveTasksError } from "../src/index.js";

// Minimal Runtime stub: the registry's load() path constructs session +
// task modules whose composers require a runtime to be registered, but
// the modules don't actually CALL it at compose time — only at
// dispatch/launch time, which our tests don't reach. A bare stub is
// enough to satisfy the runtime-registry lookup.
class StubRuntime implements Runtime {
  readonly kind = "copilot";
  readonly capabilities: RuntimeCapabilities = { remoteSession: true };
  // Every method exists but is never called by the tests; throw if
  // something unexpectedly tries to. Explicit `Promise<never>` return
  // types satisfy the `Runtime` interface (covariant `Promise<T>`)
  // without forcing the stubs to fabricate a real response shape.
  async provision(): Promise<never> {
    throw new Error("StubRuntime.provision: not implemented for tests");
  }
  async buildInteractiveLaunch(): Promise<never> {
    throw new Error("StubRuntime.buildInteractiveLaunch: not implemented");
  }
  async launchHeadless(): Promise<never> {
    throw new Error("StubRuntime.launchHeadless: not implemented");
  }
  async readMetadata() {
    return null;
  }
  async readActivity() {
    return null;
  }
  async *streamActivity() {
    // empty
  }
  async deleteState() {
    // no-op
  }
}

function makeRegistry(): RuntimeRegistry {
  const reg = new RuntimeRegistry();
  reg.register(new StubRuntime());
  return reg;
}

let scratch: string;
const apps: Application[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "api-test-"));
});

afterEach(async () => {
  for (const a of apps.splice(0)) {
    try {
      await a.close();
    } catch {
      /* best-effort */
    }
  }
  await rm(scratch, { recursive: true, force: true });
});

async function makeApp(): Promise<Application> {
  const app = await composeApplication({
    workspace: { dbFile: ":memory:" },
    runtimeRegistry: makeRegistry(),
    defaultWorkspaceParent: path.join(scratch, "workspaces"),
  });
  apps.push(app);
  return app;
}

describe("composeApplication", () => {
  it("rejects a relative defaultWorkspaceParent", async () => {
    await expect(
      composeApplication({
        workspace: { dbFile: ":memory:" },
        runtimeRegistry: makeRegistry(),
        defaultWorkspaceParent: "relative/path",
      }),
    ).rejects.toThrow(/absolute/);
  });

  it("accepts an absolute defaultWorkspaceParent", async () => {
    const a = await makeApp();
    expect(a).toBeDefined();
  });
});

describe("Application orchestration", () => {
  it("registerWorkspace mints a uuid and uses defaultWorkspaceParent when dir is omitted", async () => {
    const app = await makeApp();
    const ws = await app.registerWorkspace({ name: "demo" });
    expect(ws.id).toMatch(/^[0-9a-f]{8}-/);
    expect(ws.workspaceDir.startsWith(path.join(scratch, "workspaces"))).toBe(true);
    expect(ws.workspaceDir.endsWith(ws.id)).toBe(true);
    expect(ws.name).toBe("demo");
    // Re-read via workspaceService confirms persistence
    const view = await app.workspaceService.getById(ws.id);
    expect(view?.name).toBe("demo");
  });

  it("registerWorkspace honours an explicit workspaceDir", async () => {
    const app = await makeApp();
    const dir = path.join(scratch, "explicit");
    const ws = await app.registerWorkspace({ name: "explicit", workspaceDir: dir });
    expect(ws.workspaceDir).toBe(path.resolve(dir));
  });

  it("renameWorkspace invalidates the per-workspace context", async () => {
    const app = await makeApp();
    const ws = await app.registerWorkspace({ name: "before" });
    // Touch the context once so there's something to invalidate.
    await app.getContext(ws.id);
    expect(app.loadedContexts()).toHaveLength(1);
    const renamed = await app.renameWorkspace(ws.id, { newName: "after" });
    expect(renamed?.name).toBe("after");
    expect(app.loadedContexts()).toHaveLength(0);
  });

  it("unregisterWorkspace invalidates the per-workspace context", async () => {
    const app = await makeApp();
    const ws = await app.registerWorkspace({ name: "demo" });
    await app.getContext(ws.id);
    expect(app.loadedContexts()).toHaveLength(1);
    await app.unregisterWorkspace(ws.id);
    expect(app.loadedContexts()).toHaveLength(0);
    expect(await app.workspaceService.getById(ws.id)).toBeNull();
  });

  it("close disposes the registry and the workspace module", async () => {
    const app = await composeApplication({
      workspace: { dbFile: ":memory:" },
      runtimeRegistry: makeRegistry(),
      defaultWorkspaceParent: path.join(scratch, "workspaces"),
    });
    const ws = await app.registerWorkspace({ name: "demo" });
    await app.getContext(ws.id);
    expect(app.loadedContexts()).toHaveLength(1);
    await app.close();
    // After close, the registry is empty (closeAll cleared it).
    expect(app.loadedContexts()).toHaveLength(0);
  });
});

describe("Application.getContext", () => {
  it("dedupes concurrent loads", async () => {
    const app = await makeApp();
    const ws = await app.registerWorkspace({ name: "demo" });
    // Spy on the workspaceService.getById to count how many times load()
    // actually fetches the workspace — should be exactly once across
    // both concurrent getContext() calls.
    const spy = vi.spyOn(app.workspaceService, "getById");
    const [a, b] = await Promise.all([app.getContext(ws.id), app.getContext(ws.id)]);
    expect(a).toBe(b); // same reference — memoised
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("Application.reloadWorkspace", () => {
  it("returns null when the workspace is no longer registered", async () => {
    const app = await makeApp();
    const result = await app.reloadWorkspace("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("refuses with WorkspaceHasLiveTasksError when live tasks exist", async () => {
    const app = await makeApp();
    const ws = await app.registerWorkspace({ name: "demo" });
    const ctx = await app.getContext(ws.id);
    if (ctx === null) throw new Error("expected context");
    // Stub liveCount() to fake an in-flight task. The context is the
    // canonical seam — reload reads `cached.tasks.liveCount()`.
    vi.spyOn(ctx.tasks, "liveCount").mockReturnValue(3);
    await expect(app.reloadWorkspace(ws.id)).rejects.toBeInstanceOf(WorkspaceHasLiveTasksError);
  });
});
