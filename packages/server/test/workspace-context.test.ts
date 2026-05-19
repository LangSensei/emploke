import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { captureLogger } from "@emploke/logger/testing";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import {
  runPkgMigrationsSync,
  SqliteWorkspaceRepository,
  WORKSPACE_MIGRATIONS,
  WorkspaceManager,
} from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceContextCache, WorkspaceHasLiveTasksError } from "../src/workspace-context.js";

/**
 * Tests for the per-workspace context cache lifecycle log lines added
 * for issue #58. The cache is the only surface in the server that
 * mutates long-lived per-workspace state outside of route handlers, so
 * its build / invalidate / reload events need to land in the log just
 * like state-mutating routes do.
 */

let scratch: string;
let globalDb: DatabaseSync;
const openCaches: WorkspaceContextCache[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-wsctx-"));
  globalDb = new DatabaseSync(":memory:");
  runPkgMigrationsSync(globalDb, [{ pkg: "workspace", migrations: WORKSPACE_MIGRATIONS }]);
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

async function makeCache() {
  const cap = captureLogger();
  const manager = new WorkspaceManager(new SqliteWorkspaceRepository({ db: globalDb }));
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(scratch, "copilot-config.json") }),
  );
  const cache = new WorkspaceContextCache({
    runtimeRegistry,
    workspaces: manager,
    logger: cap.logger,
  });
  openCaches.push(cache);
  return { cap, cache, manager };
}

describe("WorkspaceContextCache observability", () => {
  it("emits an info line on first context build, with workspaceId + workdir", async () => {
    const { cap, cache, manager } = await makeCache();
    const ws = await manager.init({ name: "alpha", workdir: path.join(scratch, "alpha") });

    const ctx = await cache.get(ws.id);
    expect(ctx).not.toBeNull();

    const built = cap.entries.find((e) => e.msg === "workspace context built (first request)");
    expect(built).toBeDefined();
    expect(built?.workspaceId).toBe(ws.id);
    expect(built?.workdir).toBe(ws.workdir);
    expect(typeof built?.dbPath).toBe("string");
  });

  it("does NOT re-emit the build line on a cache hit", async () => {
    const { cap, cache, manager } = await makeCache();
    const ws = await manager.init({ name: "alpha", workdir: path.join(scratch, "alpha") });

    await cache.get(ws.id);
    cap.entries.length = 0;
    await cache.get(ws.id);

    const built = cap.entries.find((e) => e.msg === "workspace context built (first request)");
    expect(built).toBeUndefined();
  });

  it("emits an info line on invalidate of a loaded entry", async () => {
    const { cap, cache, manager } = await makeCache();
    const ws = await manager.init({ name: "alpha", workdir: path.join(scratch, "alpha") });
    await cache.get(ws.id);
    cap.entries.length = 0;

    cache.invalidate(ws.id);

    const inv = cap.entries.find((e) => e.msg === "workspace context invalidated");
    expect(inv?.workspaceId).toBe(ws.id);
  });

  it("emits NO line when invalidate is called for an unknown id (no-op)", async () => {
    const { cap, cache } = await makeCache();
    cache.invalidate("00000000-0000-0000-0000-000000000000");
    const inv = cap.entries.find((e) => e.msg === "workspace context invalidated");
    expect(inv).toBeUndefined();
  });

  it("emits an info line on successful reload", async () => {
    const { cap, cache, manager } = await makeCache();
    const ws = await manager.init({ name: "alpha", workdir: path.join(scratch, "alpha") });
    await cache.get(ws.id);
    cap.entries.length = 0;

    const fresh = await cache.reload(ws.id);
    expect(fresh).not.toBeNull();

    const reloaded = cap.entries.find((e) => e.msg === "workspace context reloaded");
    expect(reloaded?.workspaceId).toBe(ws.id);
  });

  it("emits a warn line on reload refusal (live tasks)", async () => {
    const { cap, cache, manager } = await makeCache();
    const ws = await manager.init({ name: "alpha", workdir: path.join(scratch, "alpha") });
    const ctx = await cache.get(ws.id);
    if (ctx === null) throw new Error("expected workspace context");

    // Inject a fake live count so the gate engages without spawning a
    // real task subprocess. liveCount() is the only TaskManager surface
    // reload reads, so monkey-patching it on the cached instance is
    // sufficient to drive the refusal branch.
    const orig = ctx.tasks.liveCount.bind(ctx.tasks);
    (ctx.tasks as unknown as { liveCount: () => number }).liveCount = () => 1;
    cap.entries.length = 0;

    try {
      await expect(cache.reload(ws.id)).rejects.toBeInstanceOf(WorkspaceHasLiveTasksError);

      const refused = cap.entries.find(
        (e) => e.msg === "workspace reload refused: live tasks would be orphaned",
      );
      expect(refused?.level).toBe(40); // warn
      expect(refused?.workspaceId).toBe(ws.id);
      expect(refused?.liveCount).toBe(1);
    } finally {
      (ctx.tasks as unknown as { liveCount: () => number }).liveCount = orig;
    }
  });
});
