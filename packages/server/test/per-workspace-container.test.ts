import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { captureLogger } from "@emploke/logger/testing";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import { RegisterWorkspaceCommand, WorkspaceQueries } from "@emploke/workspace";
import { Mediator } from "mediatr-ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServerContainer } from "../src/bootstrap.js";
import {
  PerWorkspaceContainerCache,
  WorkspaceHasLiveTasksError,
} from "../src/per-workspace-container.js";
import { bootstrapWorkspaceRegistryDb } from "./_test-support.js";

/**
 * Tests for the per-workspace container cache lifecycle log lines added
 * for issue #58. The cache is the only surface in the server that
 * mutates long-lived per-workspace state outside of route handlers, so
 * its build / invalidate / reload events need to land in the log just
 * like state-mutating routes do.
 *
 * Post-Phase-1: `WorkspaceContextCache` was renamed to
 * `PerWorkspaceContainerCache` (P1-4 in polish-backlog). The log
 * messages were updated accordingly ("per-workspace container ..."
 * instead of "workspace context ...").
 */

let scratch: string;
let globalDb: DatabaseSync;
const openCaches: PerWorkspaceContainerCache[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-wsctx-"));
  globalDb = new DatabaseSync(":memory:");
  await bootstrapWorkspaceRegistryDb(globalDb);
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

interface CacheHarness {
  cap: ReturnType<typeof captureLogger>;
  cache: PerWorkspaceContainerCache;
  mediator: Mediator;
  queries: WorkspaceQueries;
}

async function makeCache(): Promise<CacheHarness> {
  const cap = captureLogger();
  const container = buildServerContainer({ workspaceDb: globalDb });
  const mediator = container.get(Mediator);
  const queries = container.get(WorkspaceQueries);
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(scratch, "copilot-config.json") }),
  );
  const cache = new PerWorkspaceContainerCache({
    rootContainer: container,
    runtimeRegistry,
    queries,
    logger: cap.logger,
  });
  openCaches.push(cache);
  return { cap, cache, mediator, queries };
}

async function registerWs(
  mediator: Mediator,
  args: { name: string; workspaceDir: string },
): Promise<{ id: string; workspaceDir: string }> {
  const id = (await import("node:crypto")).randomUUID();
  const result = await mediator.send(
    new RegisterWorkspaceCommand(id, args.workspaceDir, args.name),
  );
  return { id: result.id, workspaceDir: path.resolve(args.workspaceDir) };
}

describe("PerWorkspaceContainerCache observability", () => {
  it("emits an info line on first container build, with workspaceId + workspaceDir", async () => {
    const { cap, cache, mediator } = await makeCache();
    const ws = await registerWs(mediator, {
      name: "alpha",
      workspaceDir: path.join(scratch, "alpha"),
    });

    const ctx = await cache.get(ws.id);
    expect(ctx).not.toBeNull();

    const built = cap.entries.find(
      (e) => e.msg === "per-workspace container built (first request)",
    );
    expect(built).toBeDefined();
    expect(built?.workspaceId).toBe(ws.id);
    expect(built?.workspaceDir).toBe(ws.workspaceDir);
    expect(typeof built?.dbPath).toBe("string");
  });

  it("does NOT re-emit the build line on a cache hit", async () => {
    const { cap, cache, mediator } = await makeCache();
    const ws = await registerWs(mediator, {
      name: "alpha",
      workspaceDir: path.join(scratch, "alpha"),
    });

    await cache.get(ws.id);
    cap.entries.length = 0;
    await cache.get(ws.id);

    const built = cap.entries.find(
      (e) => e.msg === "per-workspace container built (first request)",
    );
    expect(built).toBeUndefined();
  });

  it("emits an info line on invalidate of a loaded entry", async () => {
    const { cap, cache, mediator } = await makeCache();
    const ws = await registerWs(mediator, {
      name: "alpha",
      workspaceDir: path.join(scratch, "alpha"),
    });
    await cache.get(ws.id);
    cap.entries.length = 0;

    cache.invalidate(ws.id);

    const inv = cap.entries.find((e) => e.msg === "per-workspace container invalidated");
    expect(inv?.workspaceId).toBe(ws.id);
  });

  it("emits NO line when invalidate is called for an unknown id (no-op)", async () => {
    const { cap, cache } = await makeCache();
    cache.invalidate("00000000-0000-0000-0000-000000000000");
    const inv = cap.entries.find((e) => e.msg === "per-workspace container invalidated");
    expect(inv).toBeUndefined();
  });

  it("emits an info line on successful reload", async () => {
    const { cap, cache, mediator } = await makeCache();
    const ws = await registerWs(mediator, {
      name: "alpha",
      workspaceDir: path.join(scratch, "alpha"),
    });
    await cache.get(ws.id);
    cap.entries.length = 0;

    const fresh = await cache.reload(ws.id);
    expect(fresh).not.toBeNull();

    const reloaded = cap.entries.find((e) => e.msg === "per-workspace container reloaded");
    expect(reloaded?.workspaceId).toBe(ws.id);
  });

  it("emits a warn line on reload refusal (live tasks)", async () => {
    const { cap, cache, mediator } = await makeCache();
    const ws = await registerWs(mediator, {
      name: "alpha",
      workspaceDir: path.join(scratch, "alpha"),
    });
    const ctx = await cache.get(ws.id);
    if (ctx === null) throw new Error("expected per-workspace container");

    // Inject a fake live count so the gate engages without spawning a
    // real task subprocess.
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
