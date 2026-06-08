/**
 * Integration tests for the M2.1 stub coordinator runner wired into a
 * real `composeWorkflowModule` alongside a fake in-memory worker
 * runner. Covers the three end-to-end terminal-status paths
 * enumerated in spec issue #327 §4.2 (I1–I3).
 *
 * No real `@emploke/task` or `@emploke/catalog` is wired here — the
 * fake worker mirrors the test runner pattern from
 * `packages/workflow/test/engine-integration.test.ts:66-107`. This
 * keeps the test focused on substrate ↔ stub-coord correctness and
 * decoupled from task-runtime correctness.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  composeWorkflowModule,
  type WorkflowModule,
  type WorkflowNodeRunner,
  type WorkflowNodeValidateCtx,
} from "@emploke/workflow";
import { openTestWorkflowDb } from "@emploke/workflow/testing";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeWorkflowStubCoordRunner,
  WORKFLOW_STUB_WORKER_AGENT,
  WORKFLOW_STUB_WORKER_BRIEF,
} from "../../src/wiring/workflow-coord-runner.js";

const silentLogger = pino({ level: "silent" });
const STUB_COORD_AGENT = "stub-coord";

type WorkerTerminalConfig =
  | { readonly mode: "succeed" }
  | { readonly mode: "fail"; readonly reason: string }
  | { readonly mode: "cancel" };

/**
 * Fake worker runner used by the integration test. Mirrors the
 * pattern in `packages/workflow/test/engine-integration.test.ts:66-107`:
 * a non-poll runner that immediately schedules its terminal outcome
 * on the next microtask so the substrate has a chance to commit the
 * `ready → running` transition before the terminal write lands.
 */
function makeFakeWorker(config: {
  mode: WorkerTerminalConfig["mode"];
  reason?: string;
}): WorkflowNodeRunner & {
  readonly dispatchCalls: ReadonlyArray<{ readonly nodeId: string }>;
} {
  const dispatchCalls: Array<{ nodeId: string }> = [];
  let seq = 0;
  const runner: WorkflowNodeRunner & {
    readonly dispatchCalls: ReadonlyArray<{ readonly nodeId: string }>;
  } = {
    dispatchCalls,
    async validate(spec: unknown, _ctx: WorkflowNodeValidateCtx) {
      return spec;
    },
    async dispatch(opts) {
      dispatchCalls.push({ nodeId: opts.nodeId });
      seq += 1;
      const id = seq;
      queueMicrotask(() => {
        if (config.mode === "succeed") {
          opts.onTerminal({ status: "succeeded" });
        } else if (config.mode === "fail") {
          opts.onTerminal({ status: "failed", reason: config.reason ?? "fake worker failure" });
        } else {
          opts.onTerminal({ status: "cancelled" });
        }
      });
      return { unitId: `fake-worker-${id}` };
    },
    async hasInFlightForNode(_nodeId: string) {
      return false;
    },
    async cancel(_nodeId: string) {
      /* fake worker has no out-of-band unit to cancel */
    },
  };
  return runner;
}

interface Harness {
  readonly module: WorkflowModule;
  readonly worker: ReturnType<typeof makeFakeWorker>;
  readonly workspaceDir: string;
  readonly dbHandle: ReturnType<typeof openTestWorkflowDb>;
  cleanup(): Promise<void>;
}

async function makeHarness(workerMode: WorkerTerminalConfig["mode"]): Promise<Harness> {
  const dbHandle = openTestWorkflowDb();
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "wf-stub-coord-test-"));
  const worker = makeFakeWorker({ mode: workerMode, reason: "configured failure" });
  let serviceRef: WorkflowModule["service"] | null = null;
  const coord = makeWorkflowStubCoordRunner({
    getService: () => {
      if (serviceRef === null) {
        throw new Error(
          "WorkflowStubCoordRunner: service used before composeWorkflowModule returned",
        );
      }
      return serviceRef;
    },
    logger: silentLogger,
  });
  const module = await composeWorkflowModule({
    db: dbHandle.db,
    workspaceDir,
    runners: { coordinator: coord, worker },
    logger: silentLogger,
  });
  serviceRef = module.service;
  return {
    module,
    worker,
    workspaceDir,
    dbHandle,
    async cleanup() {
      await module.close();
      dbHandle.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}

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

describe("@emploke/api workflow-coord-runner integration (issue #327 §4.2)", () => {
  let h: Harness | null = null;
  beforeEach(() => {
    h = null;
  });
  afterEach(async () => {
    if (h !== null) await h.cleanup();
  });

  it("I1 — happy path: worker succeeds → workflow succeeded, 1 initial coord + 1 worker + 1 follow-up coord all succeeded", async () => {
    h = await makeHarness("succeed");
    const { workflowId } = await h.module.service.createWorkflow({
      brief: "smoke",
      coordinatorAgent: STUB_COORD_AGENT,
    });

    await waitUntil(
      async () => (await h?.module.service.getDag(workflowId))?.workflow.status === "succeeded",
      5000,
      "workflow reaches succeeded",
    );

    const dag = await h.module.service.getDag(workflowId);
    const coords = dag.nodes.filter((n) => n.kind === "coordinator");
    const workers = dag.nodes.filter((n) => n.kind === "worker");
    expect(coords).toHaveLength(2);
    expect(workers).toHaveLength(1);
    for (const node of dag.nodes) {
      expect(node.status).toBe("succeeded");
    }

    // The stub-coord dispatched exactly the constants exported from
    // the runner module — keeps the test and the runner in lockstep.
    expect(workers[0]?.spec).toEqual({
      agent: WORKFLOW_STUB_WORKER_AGENT,
      brief: WORKFLOW_STUB_WORKER_BRIEF,
    });
    expect(h.worker.dispatchCalls).toHaveLength(1);
  });

  it("I2 — worker fails → workflow failed, worker failed, follow-up coord still succeeded", async () => {
    h = await makeHarness("fail");
    const { workflowId } = await h.module.service.createWorkflow({
      brief: "fail-flow",
      coordinatorAgent: STUB_COORD_AGENT,
    });

    await waitUntil(
      async () => (await h?.module.service.getDag(workflowId))?.workflow.status === "failed",
      5000,
      "workflow reaches failed",
    );

    const dag = await h.module.service.getDag(workflowId);
    expect(dag.workflow.status).toBe("failed");
    const worker = dag.nodes.find((n) => n.kind === "worker");
    const coords = dag.nodes.filter((n) => n.kind === "coordinator");
    expect(worker?.status).toBe("failed");
    expect(coords).toHaveLength(2);
    // Both coords succeeded — the follow-up coord successfully drove
    // the workflow to a (failed) terminal outcome.
    for (const c of coords) {
      expect(c.status).toBe("succeeded");
    }
  });

  it("I3 — worker cancelled → workflow failed, worker cancelled, follow-up coord still succeeded", async () => {
    h = await makeHarness("cancel");
    const { workflowId } = await h.module.service.createWorkflow({
      brief: "cancel-flow",
      coordinatorAgent: STUB_COORD_AGENT,
    });

    await waitUntil(
      async () => (await h?.module.service.getDag(workflowId))?.workflow.status === "failed",
      5000,
      "workflow reaches failed (driven by cancelled worker)",
    );

    const dag = await h.module.service.getDag(workflowId);
    expect(dag.workflow.status).toBe("failed");
    const worker = dag.nodes.find((n) => n.kind === "worker");
    const coords = dag.nodes.filter((n) => n.kind === "coordinator");
    expect(worker?.status).toBe("cancelled");
    expect(coords).toHaveLength(2);
    for (const c of coords) {
      expect(c.status).toBe("succeeded");
    }
  });
});
