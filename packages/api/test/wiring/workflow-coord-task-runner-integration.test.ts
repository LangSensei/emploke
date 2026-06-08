/**
 * Integration tests for `makeCoordNodeRunner` wired into a real
 * `composeWorkflowModule`. Uses a fake `TaskService` whose
 * `dispatch` records calls and `get` returns scripted statuses, so
 * the substrate ↔ runner ↔ task-service bridge runs end-to-end
 * without standing up a real `@emploke/task` host (which would pull
 * in a runtime registry, an agent resolver, and a real workspace
 * dir for no extra coverage of THIS runner's bridging behaviour).
 *
 * Two-phase init demonstration: the coord runner is built with a
 * `getService` thunk that closes over a mutable holder; after
 * `composeWorkflowModule` returns, the holder is populated with the
 * actual `WorkflowService`. Mirrors the engine ↔ service two-phase
 * init at `compose.ts:113`.
 *
 * The worker runner is a passthrough stub that never gets exercised
 * by these scenarios (no `addNode kind:'worker'` calls land); it
 * exists only because `WorkflowRunners` requires both fields.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CatalogService } from "@emploke/catalog";
import type { TaskService } from "@emploke/task";
import {
  composeWorkflowModule,
  type WorkflowModule,
  type WorkflowNodeRunner,
} from "@emploke/workflow";
import { openTestWorkflowDb } from "@emploke/workflow/testing";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCoordNodeRunner } from "../../src/wiring/workflow-coord-task-runner.js";

const silentLogger = pino({ level: "silent" });

// biome-ignore lint/suspicious/noExplicitAny: minimal Task-shaped object; the runner only reads id/status/success/failure.
function fakeTaskRow(overrides: Partial<{ id: string; status: string }> = {}): any {
  return {
    id: overrides.id ?? "task-id-1",
    status: overrides.status ?? "succeeded",
    metadata: {},
    agent: "coord-agent",
    brief: "wf-brief",
    origin: "workflow",
    createdAt: "2026-06-07T00:00:00.000Z",
    startedAt: "2026-06-07T00:00:00.000Z",
  };
}

interface Harness {
  readonly module: WorkflowModule;
  readonly tasks: TaskService;
  readonly dispatch: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly workspaceDir: string;
  cleanup(): Promise<void>;
}

interface MakeHarnessOpts {
  readonly initialTaskStatus?: "running" | "succeeded" | "failed" | "cancelled";
}

async function makeHarness(opts: MakeHarnessOpts = {}): Promise<Harness> {
  const initialStatus = opts.initialTaskStatus ?? "succeeded";

  const dispatch = vi.fn(async () => fakeTaskRow({ id: "tid-1", status: initialStatus }));
  const get = vi.fn(async (_id: string) => fakeTaskRow({ id: "tid-1", status: initialStatus }));
  const hasInFlightForWorkflowNode = vi.fn(async () => false);
  const listInFlightForWorkflowNode = vi.fn(async () => []);
  const cancel = vi.fn(async (_id: string) => {});
  const tasks = {
    dispatch,
    get,
    hasInFlightForWorkflowNode,
    listInFlightForWorkflowNode,
    cancel,
  } as unknown as TaskService;

  const getAgent = vi.fn(async (_fqn: string) => ({ name: "coord-agent" }));
  const catalog = { getAgent } as unknown as CatalogService;

  // Two-phase init holder. Populated after `composeWorkflowModule`
  // returns. See `compose.ts:113` for the engine ↔ service precedent.
  const serviceHolder: { service: import("@emploke/workflow").WorkflowService | null } = {
    service: null,
  };

  const coordRunner = makeCoordNodeRunner({
    tasks,
    catalog,
    getService: () => {
      const s = serviceHolder.service;
      if (s === null) {
        throw new Error(
          "integration harness: serviceHolder.service is still null; compose did not return",
        );
      }
      return s;
    },
    pollIntervalMs: 25,
    maxPollErrors: 3,
  });

  // Worker stub — never invoked in I1–I3, present only because
  // `WorkflowRunners` requires both kinds.
  const workerRunner: WorkflowNodeRunner = {
    async validate(spec) {
      return spec;
    },
    async dispatch(_opts) {
      return { unitId: "worker-stub-unit" };
    },
    async hasInFlightForNode(_nodeId) {
      return false;
    },
    async cancel(_nodeId) {},
  };

  const dbHandle = openTestWorkflowDb();
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "wf-coord-runner-int-"));
  const module = await composeWorkflowModule({
    db: dbHandle.db,
    workspaceDir,
    runners: { coordinator: coordRunner, worker: workerRunner },
    logger: silentLogger,
  });
  serviceHolder.service = module.service;

  return {
    module,
    tasks,
    dispatch,
    get,
    workspaceDir,
    async cleanup() {
      await coordRunner.dispose();
      await module.close();
      dbHandle.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}

/**
 * Spin the event loop until `predicate()` returns truthy or the
 * `timeoutMs` budget elapses. Polls every 5ms via `setImmediate`.
 * Mirrors the helper in `engine-integration.test.ts`.
 */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitUntil timed out (${timeoutMs}ms): ${label}`);
}

describe("makeCoordNodeRunner — integration with composeWorkflowModule", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("I1: createWorkflow → coord task auto-dispatches via tasks.dispatch with brief+details from workflow header", async () => {
    const { workflowId, initialCoordNodeId } = await h.module.service.createWorkflow({
      brief: "my brief",
      details: "my long details",
      coordinatorAgent: "coord-agent",
    });

    await waitUntil(() => h.dispatch.mock.calls.length >= 1, 2000, "tasks.dispatch called");

    const calls = h.dispatch.mock.calls as unknown as ReadonlyArray<
      readonly [Record<string, unknown>]
    >;
    const call = calls[0]?.[0];
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect(call.agent).toBe("coord-agent");
      expect(call.brief).toBe("my brief");
      expect(call.details).toBe("my long details");
      expect(call.origin).toBe("workflow");
      expect(call.metadata).toEqual({
        workflowId,
        workflowNodeId: initialCoordNodeId,
      });
    }
  });

  it("I2: createWorkflow without details → coord tasks.dispatch called without 'details' key", async () => {
    await h.module.service.createWorkflow({
      brief: "brief only",
      coordinatorAgent: "coord-agent",
    });

    await waitUntil(() => h.dispatch.mock.calls.length >= 1, 2000, "tasks.dispatch called");

    const calls = h.dispatch.mock.calls as unknown as ReadonlyArray<
      readonly [Record<string, unknown>]
    >;
    const call = calls[0]?.[0];
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect(call.brief).toBe("brief only");
      expect(Object.keys(call)).not.toContain("details");
    }
  });

  it("I3: coord task succeeds via fake tasks.get → substrate marks coord node succeeded", async () => {
    const { initialCoordNodeId } = await h.module.service.createWorkflow({
      brief: "succeed-test",
      coordinatorAgent: "coord-agent",
    });

    await waitUntil(
      async () => {
        const node = await h.module.service.getNode(initialCoordNodeId);
        return node.status === "succeeded";
      },
      2000,
      "coord node observed succeeded after fake tasks.get returns succeeded",
    );

    const node = await h.module.service.getNode(initialCoordNodeId);
    expect(node.status).toBe("succeeded");
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.get.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
