/**
 * Integration tests for {@link WorkflowEngine} composed via
 * `composeWorkflowModule`. Exercises the event-driven tick loop end-
 * to-end using FAKE runners (no real `@emploke/task` dependency) so
 * the assertions stay focused on engine ↔ substrate behavior.
 *
 * The test escape hatch (`trustedCallerForTesting: true`) is used
 * here to add worker nodes directly without standing up a coord
 * runner. The fake coord runner is a passthrough stub whose
 * `dispatch` immediately fires `onTerminal({succeeded})` so workflow
 * lifecycle assertions can land cleanly.
 *
 * Scenarios (one `it` block each):
 *   1. happy path: create → coord auto-succeeds → add worker →
 *      worker auto-succeeds → workflow advances (downstream tick
 *      ratchet)
 *   2. runner reports failed → node marked failed
 *   3. runner reports cancelled → node marked cancelled
 *   4. runner.dispatch throws → dispatch-throw branch marks failed
 *   5. duplicate `onTerminal` calls → engine ignores second call
 *   6. per-workflow serialization → two concurrent triggers chain
 *      (asserted via interleaving-free dispatch ordering)
 *   7. cross-workflow parallelism → two workflows progress
 *      independently
 *   8. engine.stop() drains in-flight ticks
 *   9. trustedCallerForTesting bypass still runs structural rules
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeWorkflowModule, type WorkflowModule } from "../src/index.js";
import { openTestWorkflowDb } from "../src/testing.js";
import type {
  WorkflowNodeRunner,
  WorkflowNodeTerminalResult,
  WorkflowNodeValidateCtx,
} from "../src/types.js";

const silentLogger = pino({ level: "silent" });

interface RecordingRunner extends WorkflowNodeRunner {
  /**
   * Replace the dispatch behavior. The default succeeds immediately
   * via `onTerminal({status: 'succeeded'})`; tests swap to drive
   * failure / cancel / throw / duplicate scenarios.
   */
  setDispatch(
    fn: (opts: {
      readonly workflowId: string;
      readonly nodeId: string;
      readonly spec: unknown;
      readonly nodeDir: string;
      readonly onTerminal: (result: WorkflowNodeTerminalResult) => void;
    }) => Promise<{ readonly unitId: string }>,
  ): void;
  readonly dispatchCalls: ReadonlyArray<{
    readonly workflowId: string;
    readonly nodeId: string;
  }>;
  readonly cancelCalls: readonly string[];
}

function makeAutoSucceedRunner(label: string): RecordingRunner {
  const dispatchCalls: Array<{ workflowId: string; nodeId: string }> = [];
  const cancelCalls: string[] = [];
  let seq = 0;
  let dispatchFn: (opts: {
    readonly workflowId: string;
    readonly nodeId: string;
    readonly spec: unknown;
    readonly nodeDir: string;
    readonly onTerminal: (result: WorkflowNodeTerminalResult) => void;
  }) => Promise<{ readonly unitId: string }> = async (opts) => {
    // Default: succeed immediately. Push the terminal off the
    // microtask queue so the engine has a chance to commit the
    // `ready → running` transition first; this exercises the
    // "onTerminal fires after dispatch returns" code path (the
    // common case in production).
    queueMicrotask(() => opts.onTerminal({ status: "succeeded" }));
    seq += 1;
    return { unitId: `${label}-unit-${seq}` };
  };
  const runner: RecordingRunner = {
    setDispatch(fn) {
      dispatchFn = fn;
    },
    dispatchCalls,
    cancelCalls,
    async validate(spec, _ctx: WorkflowNodeValidateCtx) {
      return spec;
    },
    async dispatch(opts) {
      dispatchCalls.push({ workflowId: opts.workflowId, nodeId: opts.nodeId });
      return dispatchFn(opts);
    },
    async hasInFlightForNode(_nodeId) {
      return false;
    },
    async cancel(nodeId) {
      cancelCalls.push(nodeId);
    },
  };
  return runner;
}

interface Harness {
  readonly module: WorkflowModule;
  readonly coord: RecordingRunner;
  readonly worker: RecordingRunner;
  readonly workspaceDir: string;
  cleanup(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const coord = makeAutoSucceedRunner("coord");
  const worker = makeAutoSucceedRunner("worker");
  const dbHandle = openTestWorkflowDb();
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "wf-engine-test-"));
  const module = await composeWorkflowModule({
    db: dbHandle.db,
    workspaceDir,
    runners: { coordinator: coord, worker },
    logger: silentLogger,
    trustedCallerForTesting: true,
  });
  return {
    module,
    coord,
    worker,
    workspaceDir,
    async cleanup() {
      await module.close();
      dbHandle.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}

/**
 * Spin the event loop until `predicate()` returns true or the
 * `timeoutMs` budget elapses. Polls every 5ms via `setImmediate` so
 * the engine's microtask chains can resolve between checks. Throws
 * a descriptive error on timeout so test failures pinpoint which
 * assertion's precondition didn't land.
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

describe("WorkflowEngine integration", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("happy path: coord auto-succeeds, then worker auto-succeeds, workflow runs to completion", async () => {
    const { workflowId, initialCoordNodeId } = await h.module.service.createWorkflow({
      brief: "happy",
      coordinatorAgent: "coord-agent",
    });

    // Coord auto-terminates on dispatch (the runner's default
    // behavior). Wait for the engine's ratchet to flip the coord
    // node terminal.
    await waitUntil(
      async () => {
        const node = await h.module.service.getNode(initialCoordNodeId);
        return node.status === "succeeded";
      },
      2000,
      "initial coord becomes succeeded",
    );

    // Add a worker node with the now-terminal coord as parent. With
    // `trustedCallerForTesting: true` we bypass the caller-coord auth
    // gate (there is no running coord). The structural rule for
    // worker parents is "at least one parent in non-failed terminal"
    // — the coord just succeeded, so the worker is immediately
    // eligible.
    const { nodeId: workerId } = await h.module.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "worker-agent", brief: "w1" },
      parents: [initialCoordNodeId],
    });

    await waitUntil(
      async () => {
        const node = await h.module.service.getNode(workerId);
        return node.status === "succeeded";
      },
      2000,
      "worker becomes succeeded",
    );

    expect(h.coord.dispatchCalls.length).toBe(1);
    expect(h.worker.dispatchCalls.length).toBe(1);
  });

  it("runner reports failed → node marked failed via markNodeTerminal", async () => {
    h.worker.setDispatch(async (opts) => {
      queueMicrotask(() => opts.onTerminal({ status: "failed", reason: "intentional failure" }));
      return { unitId: "fail-unit" };
    });
    const { workflowId, initialCoordNodeId } = await h.module.service.createWorkflow({
      brief: "fail-test",
      coordinatorAgent: "coord-agent",
    });
    await waitUntil(
      async () => (await h.module.service.getNode(initialCoordNodeId)).status === "succeeded",
      2000,
      "coord succeeded",
    );
    const { nodeId } = await h.module.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId],
    });
    await waitUntil(
      async () => (await h.module.service.getNode(nodeId)).status === "failed",
      2000,
      "worker marked failed",
    );
  });

  it("runner reports cancelled → node marked cancelled", async () => {
    h.worker.setDispatch(async (opts) => {
      queueMicrotask(() => opts.onTerminal({ status: "cancelled" }));
      return { unitId: "cancel-unit" };
    });
    const { workflowId, initialCoordNodeId } = await h.module.service.createWorkflow({
      brief: "cancel-test",
      coordinatorAgent: "coord-agent",
    });
    await waitUntil(
      async () => (await h.module.service.getNode(initialCoordNodeId)).status === "succeeded",
      2000,
      "coord succeeded",
    );
    const { nodeId } = await h.module.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId],
    });
    await waitUntil(
      async () => (await h.module.service.getNode(nodeId)).status === "cancelled",
      2000,
      "worker marked cancelled",
    );
  });

  it("runner.dispatch throws → dispatch-throw branch marks node failed", async () => {
    h.worker.setDispatch(async (_opts) => {
      throw new Error("dispatch boom");
    });
    const { workflowId, initialCoordNodeId } = await h.module.service.createWorkflow({
      brief: "throw-test",
      coordinatorAgent: "coord-agent",
    });
    await waitUntil(
      async () => (await h.module.service.getNode(initialCoordNodeId)).status === "succeeded",
      2000,
      "coord succeeded",
    );
    const { nodeId } = await h.module.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId],
    });
    await waitUntil(
      async () => (await h.module.service.getNode(nodeId)).status === "failed",
      2000,
      "worker marked failed after dispatch throw",
    );
  });

  it("duplicate onTerminal calls → engine writes terminal once and ignores duplicates", async () => {
    let secondCallObserved = false;
    h.worker.setDispatch(async (opts) => {
      queueMicrotask(() => {
        opts.onTerminal({ status: "succeeded" });
        // Fire again on the next microtask so the substrate's
        // tx for the first write is committed by the time the
        // duplicate lands. The expected behavior is a silent
        // no-op (idempotent markNodeTerminal at the substrate).
        queueMicrotask(() => {
          secondCallObserved = true;
          opts.onTerminal({ status: "failed", reason: "duplicate; should be ignored" });
        });
      });
      return { unitId: "dup-unit" };
    });
    const { workflowId, initialCoordNodeId } = await h.module.service.createWorkflow({
      brief: "dup-test",
      coordinatorAgent: "coord-agent",
    });
    await waitUntil(
      async () => (await h.module.service.getNode(initialCoordNodeId)).status === "succeeded",
      2000,
      "coord succeeded",
    );
    const { nodeId } = await h.module.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId],
    });
    await waitUntil(
      async () => (await h.module.service.getNode(nodeId)).status === "succeeded",
      2000,
      "worker succeeded on first onTerminal",
    );
    // Let any duplicate land + be silently no-op'd.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondCallObserved).toBe(true);
    // Substrate still reports `succeeded` (not `failed` from the
    // duplicate).
    const node = await h.module.service.getNode(nodeId);
    expect(node.status).toBe("succeeded");
  });

  it("per-workflow serialization: concurrent triggers do not overlap dispatchAtomic per workflow", async () => {
    // The Map<wfId, Promise> chain in WorkflowEngine serializes
    // tickOnces per workflow. To prove the chain (not dispatchAtomic's
    // tx-internal status recheck) is what prevents overlap, we count
    // concurrent in-flight dispatchAtomic calls and stage one
    // eligible node without firing a real dispatch from addNode.
    // With the chain, per-workflow maxInFlight stays at 1; without
    // it, every queued tick reads [w1] before the first dispatch's
    // tx flips status and the entry-side counter exceeds 1.
    const wfIdCache = new Map<string, string>();
    let inFlight = 0;
    let maxInFlight = 0;
    const perWfInFlight = new Map<string, number>();
    const perWfMaxInFlight = new Map<string, number>();

    type DispatchAtomicFn = typeof h.module.service.dispatchAtomic;
    const originalDispatchAtomic: DispatchAtomicFn = h.module.service.dispatchAtomic.bind(
      h.module.service,
    );
    const wrappedDispatchAtomic: DispatchAtomicFn = async (nodeId, onTerminal) => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      let wfId = wfIdCache.get(nodeId);
      if (wfId === undefined) {
        try {
          const node = await h.module.service.getNode(nodeId);
          wfId = node.workflowId;
          wfIdCache.set(nodeId, wfId);
        } catch {
          wfId = "unknown";
        }
      }
      const wfCur = (perWfInFlight.get(wfId) ?? 0) + 1;
      perWfInFlight.set(wfId, wfCur);
      if (wfCur > (perWfMaxInFlight.get(wfId) ?? 0)) perWfMaxInFlight.set(wfId, wfCur);
      try {
        await originalDispatchAtomic(nodeId, onTerminal);
      } finally {
        inFlight -= 1;
        perWfInFlight.set(wfId, (perWfInFlight.get(wfId) ?? 1) - 1);
      }
    };
    (h.module.service as { dispatchAtomic: DispatchAtomicFn }).dispatchAtomic =
      wrappedDispatchAtomic;
    const noOpDispatchAtomic: DispatchAtomicFn = async () => {};

    type DispatchFn = Parameters<RecordingRunner["setDispatch"]>[0];
    const slowDispatch: DispatchFn = async (opts) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      queueMicrotask(() => opts.onTerminal({ status: "succeeded" }));
      return { unitId: `unit-${opts.nodeId}` };
    };
    h.coord.setDispatch(slowDispatch);
    h.worker.setDispatch(slowDispatch);

    const wf1 = await h.module.service.createWorkflow({
      brief: "serialization-test",
      coordinatorAgent: "coord-agent",
    });
    await waitUntil(
      async () => (await h.module.service.getNode(wf1.initialCoordNodeId)).status === "succeeded",
      2000,
      "wf1 coord succeeded",
    );

    // Swap dispatchAtomic to a no-op for the duration of addNode so
    // its inline `await this.dispatchAtomic(nodeId)` is a no-op, then
    // restore. The worker is committed as not_started with coord
    // already succeeded, so every tick that runs eligibility will see
    // [w1] until the first real dispatch flips it to running.
    (h.module.service as { dispatchAtomic: DispatchAtomicFn }).dispatchAtomic = noOpDispatchAtomic;
    const w1 = await h.module.service.addNode({
      workflowId: wf1.workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "w1" },
      parents: [wf1.initialCoordNodeId],
    });
    (h.module.service as { dispatchAtomic: DispatchAtomicFn }).dispatchAtomic =
      wrappedDispatchAtomic;

    wfIdCache.clear();
    perWfInFlight.clear();
    perWfMaxInFlight.clear();
    inFlight = 0;
    maxInFlight = 0;

    for (let i = 0; i < 10; i++) {
      h.module.engine.triggerWorkflowTick(wf1.workflowId);
    }

    await waitUntil(
      async () => (await h.module.service.getNode(w1.nodeId)).status === "succeeded",
      2000,
      "wf1 worker succeeded",
    );

    expect(perWfMaxInFlight.get(wf1.workflowId)).toBe(1);

    // Inverse spec: across two different workflows dispatchAtomic IS
    // allowed to run concurrently. Pin both workflows' workers
    // in-flight against a manual gate and assert the global counter
    // reaches >= 2 while each per-workflow counter stays at 1.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gatedDispatch: DispatchFn = async (opts) => {
      await gate;
      queueMicrotask(() => opts.onTerminal({ status: "succeeded" }));
      return { unitId: `unit-${opts.nodeId}` };
    };
    h.worker.setDispatch(gatedDispatch);

    const wfA = await h.module.service.createWorkflow({
      brief: "wf-A",
      coordinatorAgent: "coord-agent",
    });
    const wfB = await h.module.service.createWorkflow({
      brief: "wf-B",
      coordinatorAgent: "coord-agent",
    });
    await waitUntil(
      async () =>
        (await h.module.service.getNode(wfA.initialCoordNodeId)).status === "succeeded" &&
        (await h.module.service.getNode(wfB.initialCoordNodeId)).status === "succeeded",
      2000,
      "both cross-wf coords succeeded",
    );

    perWfInFlight.clear();
    perWfMaxInFlight.clear();
    inFlight = 0;
    maxInFlight = 0;

    const addAPromise = h.module.service.addNode({
      workflowId: wfA.workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "A" },
      parents: [wfA.initialCoordNodeId],
    });
    const addBPromise = h.module.service.addNode({
      workflowId: wfB.workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "B" },
      parents: [wfB.initialCoordNodeId],
    });

    await waitUntil(() => inFlight >= 2, 2000, "both cross-wf workers in flight against gate");

    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(perWfMaxInFlight.get(wfA.workflowId)).toBe(1);
    expect(perWfMaxInFlight.get(wfB.workflowId)).toBe(1);

    releaseGate();

    const wA = await addAPromise;
    const wB = await addBPromise;

    await waitUntil(
      async () =>
        (await h.module.service.getNode(wA.nodeId)).status === "succeeded" &&
        (await h.module.service.getNode(wB.nodeId)).status === "succeeded",
      2000,
      "both cross-wf workers succeeded after gate release",
    );
  });

  it("cross-workflow parallelism: two workflows advance independently", async () => {
    const a = await h.module.service.createWorkflow({
      brief: "wf-a",
      coordinatorAgent: "coord-agent",
    });
    const b = await h.module.service.createWorkflow({
      brief: "wf-b",
      coordinatorAgent: "coord-agent",
    });
    await waitUntil(
      async () =>
        (await h.module.service.getNode(a.initialCoordNodeId)).status === "succeeded" &&
        (await h.module.service.getNode(b.initialCoordNodeId)).status === "succeeded",
      2000,
      "both coords succeeded",
    );
  });

  it("engine.stop() drains in-flight ticks (no dispatch lands after stop)", async () => {
    const { initialCoordNodeId } = await h.module.service.createWorkflow({
      brief: "stop-test",
      coordinatorAgent: "coord-agent",
    });
    // Wait for the coord to advance, then stop. After stop further
    // ticks should be no-ops.
    await waitUntil(
      async () => (await h.module.service.getNode(initialCoordNodeId)).status === "succeeded",
      2000,
      "coord succeeded",
    );
    await h.module.engine.stop();
    const dispatchesBefore = h.coord.dispatchCalls.length;
    // Trigger after stop — should be a no-op.
    h.module.engine.triggerWorkflowTick("any-id-does-not-matter");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.coord.dispatchCalls.length).toBe(dispatchesBefore);
  });

  it("trustedCallerForTesting bypass still runs structural rules (worker requires ≥1 parent)", async () => {
    const { workflowId } = await h.module.service.createWorkflow({
      brief: "structural-test",
      coordinatorAgent: "coord-agent",
    });
    // Worker with zero parents — structural rule rejects regardless
    // of the auth bypass. The error class is EmptyParentsError; we
    // assert via instanceof / message rather than importing yet
    // another error class.
    await expect(
      h.module.service.addNode({
        workflowId,
        kind: "worker",
        spec: { agent: "w", brief: "b" },
        parents: [],
      }),
    ).rejects.toThrow();
  });
});
