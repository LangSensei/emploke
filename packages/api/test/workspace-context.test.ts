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
import type { WorkflowService } from "@emploke/workflow";
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
  // Reassigned per-test; when non-null, workflow compose throws.
  workflowThrow: null as Error | null,
  // Append-only close() call log to assert ordering.
  sequence: [] as string[],
  // Captured `getService` thunk handed to the coord runner — the
  // workspace-context fixes the workflow service ref AFTER
  // composeWorkflowModule returns, so the thunk must resolve to
  // a non-null service post-compose.
  capturedGetService: null as (() => WorkflowService) | null,
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

// `composeWorkflowModule` is mocked so the test never touches the
// workflow substrate's drizzle handle / engine. The stub captures
// the runners passed in so tests can assert they were constructed
// via `makeCoordNodeRunner` / `makeWorkerNodeRunner` (the workflow
// module is built LAST in compose, FIRST in close).
vi.mock("@emploke/workflow", () => ({
  composeWorkflowModule: vi.fn(async () => {
    if (mocks.workflowThrow !== null) throw mocks.workflowThrow;
    return {
      service: { __mock: "workflow" } as unknown as WorkflowService,
      close: vi.fn(async () => {
        mocks.sequence.push("workflow");
      }),
    };
  }),
}));

// The coord-runner factory dereferences `tasks` / `catalog` only on
// dispatch, so the test stubs are safe to pass through. We capture
// `getService` so a separate assertion can verify the two-phase
// init: the thunk must resolve to a non-null `WorkflowService`
// AFTER `composeWorkflowModule` returns.
vi.mock("../src/wiring/workflow-coord-task-runner.js", () => ({
  makeCoordNodeRunner: vi.fn((deps: { getService: () => WorkflowService }) => {
    mocks.capturedGetService = deps.getService;
    return {
      validate: vi.fn(),
      dispatch: vi.fn(),
      hasInFlightForNode: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    };
  }),
}));

vi.mock("../src/wiring/workflow-task-runner.js", () => ({
  makeWorkerNodeRunner: vi.fn(() => ({
    validate: vi.fn(),
    dispatch: vi.fn(),
    hasInFlightForNode: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  })),
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
  mocks.workflowThrow = null;
  mocks.catalogGate = Promise.resolve();
  mocks.capturedGetService = null;
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
    // Workflow closes FIRST (reverse of compose; the workflow
    // engine's drain dispatches through tasks, so tasks must still
    // be live while workflow drains).
    expect(mocks.sequence).toEqual(["workflow", "schedule", "task", "session", "catalog"]);
    expect(registry.loaded()).toHaveLength(0);
  });

  it("load() cleanup stack runs in reverse on a thrown composeScheduleModule", async () => {
    const registry = makeRegistry();
    mocks.scheduleThrow = new Error("schedule compose exploded");

    await expect(registry.get("ws-2")).rejects.toThrow("schedule compose exploded");

    // Cleanup stack popped in REVERSE of push order. Pushes were
    // catalog -> session -> task; pops run task -> session -> catalog.
    // The thrown schedule module has no close() to run (no handle
    // ever returned). Workflow is composed AFTER schedule and so
    // never gets a handle to close.
    expect(mocks.sequence).toEqual(["task", "session", "catalog"]);
    expect(registry.loaded()).toHaveLength(0);
  });
});

describe("WorkspaceContextRegistry workflow wiring", () => {
  it("exposes workflows on the loaded WorkspaceContext", async () => {
    const registry = makeRegistry();
    const ctx = await registry.get("ws-3");
    expect(ctx).not.toBeNull();
    expect(ctx?.workflows).toBeDefined();
    await registry.closeAll();
  });

  it("close stack runs workflow FIRST then schedule / task / session / catalog", async () => {
    const registry = makeRegistry();
    const ctx = await registry.get("ws-4");
    expect(ctx).not.toBeNull();
    mocks.sequence.length = 0;
    await ctx?.close();
    expect(mocks.sequence).toEqual(["workflow", "schedule", "task", "session", "catalog"]);
  });

  it("load() cleanup stack pops in reverse on a thrown composeWorkflowModule", async () => {
    const registry = makeRegistry();
    mocks.workflowThrow = new Error("workflow compose exploded");
    await expect(registry.get("ws-5")).rejects.toThrow("workflow compose exploded");
    // Workflow is composed AFTER schedule, so when it throws, the
    // cleanup pops schedule -> task -> session -> catalog in reverse.
    expect(mocks.sequence).toEqual(["schedule", "task", "session", "catalog"]);
    expect(registry.loaded()).toHaveLength(0);
  });

  it("two-phase init: getService() thunk resolves to the workflow service post-compose", async () => {
    const registry = makeRegistry();
    const ctx = await registry.get("ws-6");
    expect(ctx).not.toBeNull();
    // The coord runner's `getService` thunk was captured at compose
    // time (before the workflow service ref was assigned). Calling
    // it AFTER compose returns must yield the same service object
    // the context exposes — proves the two-phase init seam is wired
    // end-to-end.
    expect(mocks.capturedGetService).not.toBeNull();
    const resolved = mocks.capturedGetService?.();
    expect(resolved).toBe(ctx?.workflows);
    await registry.closeAll();
  });
});
