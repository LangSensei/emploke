/**
 * End-to-end acceptance test for the M2.5 coord-callback HTTP surface.
 *
 * Scope: spin up a real `WorkflowService` (in-memory SQLite, mock per-
 * kind runners), mount `workflowsRoutes` against it, then drive a
 * complete workflow lifecycle via HTTP. Asserts the wire shapes and
 * status codes for the live (substrate-backed) round-trip — distinct
 * from `workflows.test.ts` whose stubs assert only the route layer.
 *
 * The substrate's auth gate is bypassed via `trustedCallerForTesting:
 * true` for the growth primitives (`addNode` / `addEdge` /
 * `addSubgraph`); the "finalize / shrink" primitives (`finishWorkflow`
 * / `removeNode` / `removeEdge` / `replaceNodeSpec` / `cancelNode`)
 * still require a real caller-coord context — that's an intentional
 * substrate boundary and we verify the 403 mapping fires through the
 * full HTTP pipeline. To terminate the workflow without a real coord
 * caller, the test uses the operator-only `cancelWorkflow` route
 * (no auth gate), which is the production analogue of an external
 * dashboard / CLI "Stop" button.
 *
 * Coverage:
 *   1. HTTP `POST /workflows` seeds a workflow + coord row.
 *   2. Engine ticks coord to `succeeded` via mock runner.
 *   3. HTTP `POST /workflows/:wfid/subgraph` inserts a worker
 *      attached to the (now-terminal) coord via `existingParents`.
 *   4. Engine ticks worker to `succeeded`.
 *   5. HTTP `POST /workflows/:wfid/finish` from outside any coord
 *      task surfaces 403 with `code='WorkflowMutationUnauthorizedError'`
 *      — proves the auth gate fires through the HTTP→policy
 *      pipeline (the route-level tests use stubs; this exercises the
 *      live substrate).
 *   6. HTTP `POST /workflows/:wfid/cancel` (operator-only, no auth
 *      gate) flips the workflow to `cancelled`.
 *
 * Why this lives in `routes/` (not in a separate `e2e/`): it asserts
 * route-level wiring (URL paths, status codes, body shapes) against a
 * substrate composed in-process. The vitest config doesn't need to
 * change — same test runner, no port allocation, no subprocess.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  composeWorkflowModule,
  type WorkflowModule,
  type WorkflowNodeRunner,
  type WorkflowNodeTerminalResult,
} from "@emploke/workflow";
import { openTestWorkflowDb } from "@emploke/workflow/testing";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workflowsRoutes } from "../../src/routes/workflows.js";

const silentLogger = pino({ level: "silent" });

interface AutoSucceedRunner extends WorkflowNodeRunner {
  readonly dispatchCalls: ReadonlyArray<{
    readonly workflowId: string;
    readonly nodeId: string;
  }>;
}

function makeAutoSucceedRunner(label: string): AutoSucceedRunner {
  const dispatchCalls: Array<{ workflowId: string; nodeId: string }> = [];
  let seq = 0;
  const runner: AutoSucceedRunner = {
    dispatchCalls,
    async validate(spec) {
      return spec;
    },
    async dispatch(opts: {
      readonly workflowId: string;
      readonly nodeId: string;
      readonly spec: unknown;
      readonly nodeDir: string;
      readonly onTerminal: (result: WorkflowNodeTerminalResult) => void;
    }) {
      dispatchCalls.push({ workflowId: opts.workflowId, nodeId: opts.nodeId });
      // Push the terminal onto the microtask queue so the engine has
      // a chance to commit `ready → running` first (mirrors production
      // timing where dispatch returns before the unit settles).
      queueMicrotask(() => opts.onTerminal({ status: "succeeded" }));
      seq += 1;
      return { unitId: `${label}-unit-${seq}` };
    },
    async hasInFlightForNode() {
      return false;
    },
    async cancel() {},
  };
  return runner;
}

interface Harness {
  readonly module: WorkflowModule;
  readonly app: ReturnType<typeof workflowsRoutes>;
  readonly coord: AutoSucceedRunner;
  readonly worker: AutoSucceedRunner;
  cleanup(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const coord = makeAutoSucceedRunner("coord");
  const worker = makeAutoSucceedRunner("worker");
  const dbHandle = openTestWorkflowDb();
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "wf-e2e-coord-"));
  const module = await composeWorkflowModule({
    db: dbHandle.db,
    workspaceDir,
    runners: { coordinator: coord, worker },
    logger: silentLogger,
    trustedCallerForTesting: true,
  });
  const app = workflowsRoutes(() => module.service);
  return {
    module,
    app,
    coord,
    worker,
    async cleanup() {
      await module.close();
      dbHandle.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}

/**
 * Spin the event loop until `predicate()` returns true or the budget
 * elapses. Polls every 5ms via `setImmediate` so engine microtasks
 * can resolve between checks.
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

describe("workflowsRoutes — E2E mock-coord acceptance", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("HTTP create → addSubgraph → cancel drives a workflow over the live substrate", async () => {
    // 1. Create workflow via HTTP — seeds workflow + initial coord node.
    const createRes = await h.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: "ship feature X",
        coordinatorAgent: "mock-coord",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      status: string;
      iterationCount: number;
    };
    const wfid = created.id;
    expect(created.status).toBe("running");
    expect(created.iterationCount).toBe(1);

    // 2. Wait for the coord runner to auto-succeed. The engine flips
    //    the coord row to `succeeded`, freeing the workflow for the
    //    next mutation.
    await waitUntil(
      async () => {
        const dagRes = await h.app.request(`/${wfid}/dag`);
        const dag = (await dagRes.json()) as {
          nodes: Array<{ status: string }>;
        };
        return dag.nodes.every((n) => n.status === "succeeded");
      },
      5000,
      "initial coord auto-succeeds",
    );

    // 3. Add a worker via the addSubgraph HTTP surface (exercising the
    //    most complex mutation primitive in one call: temp-id alloc,
    //    intra-batch edge translation, NodeRefWire→NodeRef boundary).
    //    We attach the new worker to the (now-succeeded) initial coord
    //    via `existingParents`. The substrate's structural rule for
    //    worker parents is "≥1 parent in non-failed terminal" — the
    //    coord just succeeded, so the worker is immediately eligible.
    const dagBeforeRes = await h.app.request(`/${wfid}/dag`);
    const dagBefore = (await dagBeforeRes.json()) as {
      nodes: Array<{ id: string; spec: { kind: string } }>;
    };
    const coordNode = dagBefore.nodes.find((n) => n.spec.kind === "coordinator");
    expect(coordNode).toBeDefined();
    const coordId = coordNode?.id;
    if (typeof coordId !== "string") throw new Error("coord node not found");

    const subgraphRes = await h.app.request(`/${wfid}/subgraph`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodes: [
          {
            tempId: "w1",
            kind: "worker",
            spec: { agent: "mock-worker", brief: "do thing" },
            existingParents: [coordId],
          },
        ],
        edges: [],
      }),
    });
    expect(subgraphRes.status).toBe(200);
    const subgraphBody = (await subgraphRes.json()) as {
      insertedNodes: Array<{ tempId: string; nodeId: string; phase: number }>;
    };
    expect(subgraphBody.insertedNodes).toHaveLength(1);
    expect(subgraphBody.insertedNodes[0]?.tempId).toBe("w1");
    const workerNodeId = subgraphBody.insertedNodes[0]?.nodeId as string;

    // 4. Wait for the worker to auto-succeed.
    await waitUntil(
      async () => {
        const dagRes = await h.app.request(`/${wfid}/dag`);
        const dag = (await dagRes.json()) as {
          nodes: Array<{ id: string; status: string }>;
        };
        const workerRow = dag.nodes.find((n) => n.id === workerNodeId);
        return workerRow?.status === "succeeded";
      },
      5000,
      "worker auto-succeeds",
    );

    // 5. POST /finish from outside any coord task → 403 from the auth
    //    gate. Verifies the WorkflowMutationUnauthorizedError → 403
    //    mapping fires through the live substrate → error policy →
    //    HTTP response pipeline (the route-layer tests use stubs and
    //    can't catch a regression in the substrate's gate logic).
    const finishRes = await h.app.request(`/${wfid}/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "succeeded" }),
    });
    expect(finishRes.status).toBe(403);
    const finishErr = (await finishRes.json()) as { code?: string };
    expect(finishErr.code).toBe("WorkflowMutationUnauthorizedError");

    // 6. Terminate via the operator-only `cancelWorkflow` route (no
    //    auth gate — `cancelWorkflow` is the dashboard/CLI "Stop"
    //    button). The substrate flips the workflow to `cancelled` and
    //    reconciles any non-terminal nodes (none here, both already
    //    succeeded).
    const cancelRes = await h.app.request(`/${wfid}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    const cancelled = (await cancelRes.json()) as { status: string; endedAt?: string };
    expect(cancelled.status).toBe("cancelled");
    expect(typeof cancelled.endedAt).toBe("string");

    // 7. Sanity-check the runner call counts — the flow exercised one
    //    coord dispatch + one worker dispatch.
    expect(h.coord.dispatchCalls).toHaveLength(1);
    expect(h.worker.dispatchCalls).toHaveLength(1);
  }, 15000);

  it("HTTP addNode + addEdge wire round-trip lands real DB rows", async () => {
    // Seed.
    const createRes = await h.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "addnode flow", coordinatorAgent: "mock-coord" }),
    });
    expect(createRes.status).toBe(201);
    const wfid = ((await createRes.json()) as { id: string }).id;

    // Wait for coord to terminate.
    await waitUntil(
      async () => {
        const dag = (await (await h.app.request(`/${wfid}/dag`)).json()) as {
          nodes: Array<{ status: string }>;
        };
        return dag.nodes.every((n) => n.status === "succeeded");
      },
      5000,
      "initial coord auto-succeeds",
    );
    const dagBefore = (await (await h.app.request(`/${wfid}/dag`)).json()) as {
      nodes: Array<{ id: string; spec: { kind: string } }>;
    };
    const coordId = dagBefore.nodes.find((n) => n.spec.kind === "coordinator")?.id as string;

    // addNode — single worker A attached to the coord.
    const addARes = await h.app.request(`/${wfid}/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "worker",
        spec: { agent: "mock-worker", brief: "A" },
        parents: [coordId],
      }),
    });
    expect(addARes.status).toBe(200);
    const { nodeId: aId } = (await addARes.json()) as { nodeId: string; phase: number };

    // The worker auto-succeeds via the mock runner. Wait for it before
    // adding B (B will depend on A — addEdge requires the target to be
    // not_started, so we make B first then edge A → B... but A is
    // already terminal). Use a fresh worker C as the second node.
    await waitUntil(
      async () => {
        const dag = (await (await h.app.request(`/${wfid}/dag`)).json()) as {
          nodes: Array<{ id: string; status: string }>;
        };
        return dag.nodes.find((n) => n.id === aId)?.status === "succeeded";
      },
      5000,
      "worker A auto-succeeds",
    );

    // addNode — worker B attached to coord (not A; we'll wire A→B via
    // addEdge once B is in but BEFORE its dispatch).
    // Note: in mock-runner land B auto-dispatches as soon as it has a
    // terminal parent. To prove addEdge wire shape, we have to attach
    // B to coord (so it's not blocked) but also confirm `addEdge`
    // returns 409 with `WorkflowNodeNotMutableError` once B's
    // not_started gate has flipped. This proves the gate fires on
    // the live substrate via the HTTP path.
    const addBRes = await h.app.request(`/${wfid}/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "worker",
        spec: { agent: "mock-worker", brief: "B" },
        parents: [coordId],
      }),
    });
    expect(addBRes.status).toBe(200);
    const { nodeId: bId } = (await addBRes.json()) as { nodeId: string; phase: number };

    // Wait for B to terminate too.
    await waitUntil(
      async () => {
        const dag = (await (await h.app.request(`/${wfid}/dag`)).json()) as {
          nodes: Array<{ id: string; status: string }>;
        };
        return dag.nodes.find((n) => n.id === bId)?.status === "succeeded";
      },
      5000,
      "worker B auto-succeeds",
    );

    // Now addEdge A → B fails with 409 because B is no longer
    // not_started. Proves the live substrate's structural rule fires
    // through the HTTP→error policy pipeline.
    const edgeRes = await h.app.request(`/${wfid}/edges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromNodeId: aId, toNodeId: bId }),
    });
    expect(edgeRes.status).toBe(409);
    const errBody = (await edgeRes.json()) as { code?: string };
    expect(errBody.code).toBe("WorkflowNodeNotMutableError");

    // Clean termination.
    await h.app.request(`/${wfid}/cancel`, { method: "POST" });
  }, 15000);
});
