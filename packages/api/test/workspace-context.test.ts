/**
 * Pinned race-semantics tests for the internal
 * `WorkspaceContextRegistry`. The class is exported from
 * `workspace-context.ts` but NOT re-exported on the package barrel;
 * this file imports it via the relative path so the pkg-internal
 * contract stays testable without widening the public surface.
 *
 * Two scenarios:
 *
 *   1. `closeAll()` drains an inflight `get()` before disposing.
 *      Without the drain a concurrent load resolves after closeAll
 *      clears the map, leaving the freshly-built context in the
 *      `entries` map past process exit.
 *
 *   2. `load()`'s cleanup stack runs in reverse on a thrown
 *      `composeScheduleModule`. The previously-built catalog /
 *      session / task modules must each have `close()` called in
 *      reverse-of-compose order so SQLite handles + WAL pins don't
 *      leak on the failure path.
 *
 * Both tests mock the per-BC `compose*Module` functions and
 * `node:fs/promises.mkdir` so the registry exercises its lifecycle
 * paths without touching disk or any real BC code.
 */
import type { CatalogService } from "@emploke/catalog";
import { RuntimeRegistry } from "@emploke/runtime";
import type { ScheduleService } from "@emploke/schedule";
import type { SessionService, SpawnFn } from "@emploke/session";
import type { TaskService } from "@emploke/task";
import type { Workspace, WorkspaceService } from "@emploke/workspace";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

function makeGate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  // Reassigned per-test; default is "resolve immediately".
  catalogGate: Promise.resolve() as Promise<void>,
  // Reassigned per-test; when non-null, schedule compose throws.
  scheduleThrow: null as Error | null,
  // Append-only close() call log to assert ordering.
  sequence: [] as string[],
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
}));

vi.mock("@emploke/catalog", () => ({
  composeCatalogModule: vi.fn(async () => {
    await mocks.catalogGate;
    return {
      service: {} as CatalogService,
      close: vi.fn(async () => {
        mocks.sequence.push("catalog");
      }),
    };
  }),
}));

vi.mock("@emploke/session", () => ({
  composeSessionModule: vi.fn(async () => ({
    service: {} as SessionService,
    close: vi.fn(async () => {
      mocks.sequence.push("session");
    }),
  })),
}));

vi.mock("@emploke/task", () => ({
  composeTaskModule: vi.fn(async () => ({
    service: {
      recoverOrphaned: vi.fn(async () => undefined),
      liveCount: vi.fn(() => 0),
    } as unknown as TaskService,
    close: vi.fn(async () => {
      mocks.sequence.push("task");
    }),
  })),
}));

vi.mock("@emploke/schedule", () => ({
  composeScheduleModule: vi.fn(async () => {
    if (mocks.scheduleThrow !== null) throw mocks.scheduleThrow;
    return {
      service: {
        registerKind: vi.fn(),
        recover: vi.fn(async () => undefined),
      } as unknown as ScheduleService,
      close: vi.fn(async () => {
        mocks.sequence.push("schedule");
      }),
    };
  }),
}));

import { WorkspaceContextRegistry } from "../src/workspace-context.js";

function makeRegistry(): WorkspaceContextRegistry {
  const workspaceService = {
    getById: vi.fn(
      async (id: string): Promise<Workspace | null> =>
        ({
          id,
          name: "test",
          workspaceDir: "/tmp/registry-test",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        }) as Workspace,
    ),
  } as unknown as WorkspaceService;
  return new WorkspaceContextRegistry({
    workspaceService,
    runtimeRegistry: new RuntimeRegistry(),
    spawnFn: vi.fn() as unknown as SpawnFn,
  });
}

beforeEach(() => {
  mocks.sequence.length = 0;
  mocks.scheduleThrow = null;
  mocks.catalogGate = Promise.resolve();
});

describe("WorkspaceContextRegistry race semantics", () => {
  it("closeAll drains inflight get() before disposing", async () => {
    const registry = makeRegistry();
    const gate = makeGate();
    mocks.catalogGate = gate.promise;

    // Start a get() whose load() is now blocked at composeCatalogModule.
    const getP = registry.get("ws-1");

    // closeAll runs concurrently — must NOT race past the inflight
    // load. It reads `this.inflight` synchronously, then awaits the
    // promise before iterating `entries`.
    const closeP = registry.closeAll();

    // Unblock the catalog compose so the load can finish.
    gate.resolve();

    const ctx = await getP;
    await closeP;

    expect(ctx).not.toBeNull();
    // Drain worked: the context's close() ran end-to-end (reverse-
    // of-compose order). Without the drain, closeAll would have
    // iterated an empty `entries` map and the freshly-built context
    // would have been leaked past closeAll's return.
    expect(mocks.sequence).toEqual(["schedule", "task", "session", "catalog"]);
    expect(registry.loaded()).toHaveLength(0);
  });

  it("load() cleanup stack runs in reverse on a thrown composeScheduleModule", async () => {
    const registry = makeRegistry();
    mocks.scheduleThrow = new Error("schedule compose exploded");

    await expect(registry.get("ws-2")).rejects.toThrow("schedule compose exploded");

    // Cleanup stack popped in REVERSE of push order. Pushes were
    // catalog -> session -> task; pops run task -> session -> catalog.
    // The thrown schedule module has no close() to run (no handle
    // ever returned).
    expect(mocks.sequence).toEqual(["task", "session", "catalog"]);
    expect(registry.loaded()).toHaveLength(0);
  });
});
