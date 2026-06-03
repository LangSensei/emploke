import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Application, WorkspaceHasLiveTasksError } from "@emploke/api";
import type { WorkspaceService } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLogger } from "./_capture-logger.js";
import {
  type ServerTestSubsystem,
  setupTestSubsystem,
  teardownTestSubsystem,
} from "./_test-support.js";

/**
 * Tests for the per-workspace context lifecycle log lines added for
 * issue #58. The internal `WorkspaceContextRegistry` is the only
 * surface in the server that mutates long-lived per-workspace state
 * outside of route handlers, so its build / invalidate / reload events
 * need to land in the log just like state-mutating routes do. We
 * exercise it through the public `Application` surface (`getContext`,
 * `renameWorkspace`, `reloadWorkspace`) rather than reaching at the
 * registry directly.
 *
 * The global registry is opened via the workspace pkg's Drizzle
 * composer (`setupTestSubsystem` does this internally).
 */

let scratch: string;
const openSubsystems: ServerTestSubsystem[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-wsctx-"));
});
afterEach(async () => {
  for (const sys of openSubsystems.splice(0)) {
    await teardownTestSubsystem(sys);
  }
  await rm(scratch, { recursive: true, force: true });
});

interface Harness {
  cap: ReturnType<typeof captureLogger>;
  application: Application;
  service: WorkspaceService;
  queries: WorkspaceService;
}

async function makeHarness(): Promise<Harness> {
  const cap = captureLogger();
  const sys = await setupTestSubsystem({ scratch, logger: cap.logger });
  openSubsystems.push(sys);
  return { cap, application: sys.application, service: sys.service, queries: sys.service };
}

async function registerWs(
  service: WorkspaceService,
  args: { name: string; workspaceDir: string },
): Promise<{ id: string; workspaceDir: string }> {
  const id = (await import("node:crypto")).randomUUID();
  const result = await service.register({
    id,
    workspaceDir: args.workspaceDir,
    name: args.name,
  });
  return { id: result.id, workspaceDir: path.resolve(args.workspaceDir) };
}

describe("WorkspaceContext observability", () => {
  it("emits an info line on first container build, with workspaceId + workspaceDir", async () => {
    const { cap, application, service } = await makeHarness();
    const ws = await registerWs(service, {
      name: "alpha",
      workspaceDir: path.join(scratch, "alpha"),
    });

    const ctx = await application.getContext(ws.id);
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
    const { cap, application, service } = await makeHarness();
    const ws = await registerWs(service, {
      name: "alpha",
      workspaceDir: path.join(scratch, "alpha"),
    });

    await application.getContext(ws.id);
    cap.entries.length = 0;
    await application.getContext(ws.id);

    const built = cap.entries.find(
      (e) => e.msg === "per-workspace container built (first request)",
    );
    expect(built).toBeUndefined();
  });

  it("emits an info line on invalidate of a loaded entry (via rename)", async () => {
    const { cap, application, service } = await makeHarness();
    const ws = await registerWs(service, {
      name: "alpha",
      workspaceDir: path.join(scratch, "alpha"),
    });
    await application.getContext(ws.id);
    cap.entries.length = 0;

    // Renaming a workspace invalidates its cached context as a side
    // effect — the canonical public-surface path to exercising the
    // registry's invalidate observability hook.
    await application.renameWorkspace(ws.id, { newName: "alpha-renamed" });

    const inv = cap.entries.find((e) => e.msg === "per-workspace container invalidated");
    expect(inv?.workspaceId).toBe(ws.id);
  });

  it("emits NO line when invalidate is triggered for an unknown id (no-op)", async () => {
    const { cap, application } = await makeHarness();
    // unregisterWorkspace is idempotent — calling it for an id we never
    // registered is a no-op and must NOT log a spurious invalidated
    // line (there is nothing to invalidate).
    await application.unregisterWorkspace("00000000-0000-0000-0000-000000000000");
    const inv = cap.entries.find((e) => e.msg === "per-workspace container invalidated");
    expect(inv).toBeUndefined();
  });

  it("emits an info line on successful reload", async () => {
    const { cap, application, service } = await makeHarness();
    const ws = await registerWs(service, {
      name: "alpha",
      workspaceDir: path.join(scratch, "alpha"),
    });
    await application.getContext(ws.id);
    cap.entries.length = 0;

    const fresh = await application.reloadWorkspace(ws.id);
    expect(fresh).not.toBeNull();

    const reloaded = cap.entries.find((e) => e.msg === "per-workspace container reloaded");
    expect(reloaded?.workspaceId).toBe(ws.id);
  });

  it("emits a warn line on reload refusal (live tasks)", async () => {
    const { cap, application, service } = await makeHarness();
    const ws = await registerWs(service, {
      name: "alpha",
      workspaceDir: path.join(scratch, "alpha"),
    });
    const ctx = await application.getContext(ws.id);
    if (ctx === null) throw new Error("expected per-workspace container");

    // Inject a fake live count so the gate engages without spawning a
    // real task subprocess.
    const orig = ctx.tasks.liveCount.bind(ctx.tasks);
    (ctx.tasks as unknown as { liveCount: () => number }).liveCount = () => 1;
    cap.entries.length = 0;

    try {
      await expect(application.reloadWorkspace(ws.id)).rejects.toBeInstanceOf(
        WorkspaceHasLiveTasksError,
      );

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
