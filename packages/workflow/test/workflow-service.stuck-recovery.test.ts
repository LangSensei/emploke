/**
 * Tests for the substrate's stuck-coord recovery (Issue #352 group E).
 *
 * The recovery mechanism has three observable surfaces:
 *
 *  1. The mutation primitives fire an in-tx detector at commit time;
 *     when a workflow is in a quiescent stuck state (status=running,
 *     every node terminal, leaves form one of the stuck shapes) the
 *     detector inserts a retry coord node and the wrapping write
 *     post-commit dispatches it.
 *  2. `recoverStuck(workflowId)` and `recoverStuckAll()` give admin
 *     callers an explicit entry point that wraps the same detector
 *     in its own tx. Idempotent — a non-stuck workflow returns
 *     `{ inserted: false }` with no writes.
 *  3. `addSubgraph` rejects batches whose final leaf frontier is not
 *     exactly `{1 coordinator}` with `WorkflowDagInvariantError` so
 *     callers can never push a workflow into a structurally-stuck
 *     shape in a single primitive.
 *
 * Tests below mirror §15 of the design (15.1–15.11).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractNodeRetryMetadata, WorkflowDagInvariantError } from "../src/index.js";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService — stuck-coord recovery", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  // ─── 15.1 — addSubgraph commit-time leaf-frontier invariant ────────

  it("§15.1 addSubgraph rejects a batch that yields worker-only leaves", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "t",
            kind: "worker",
            spec: { agent: "w", brief: "x" },
            existingParents: [initialCoordNodeId],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(WorkflowDagInvariantError);
  });

  it("§15.1 addSubgraph rejects a batch that yields two leaves", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "a",
            kind: "worker",
            spec: { agent: "w", brief: "a" },
            existingParents: [initialCoordNodeId],
          },
          {
            tempId: "b",
            kind: "worker",
            spec: { agent: "w", brief: "b" },
            existingParents: [initialCoordNodeId],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(WorkflowDagInvariantError);
  });

  it("§15.1 addSubgraph accepts a batch whose final leaves are {1 coord}", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const res = await h.service.addSubgraph({
      workflowId,
      nodes: [
        {
          tempId: "w",
          kind: "worker",
          spec: { agent: "w", brief: "x" },
          existingParents: [initialCoordNodeId],
        },
        {
          tempId: "c",
          kind: "coordinator",
          spec: { agent: "coord-end" },
          existingParents: [initialCoordNodeId],
        },
      ],
      edges: [{ from: { kind: "temp", tempId: "w" }, to: { kind: "temp", tempId: "c" } }],
    });
    expect(res.insertedNodes.length).toBe(2);
  });

  // ─── 15.2 — Stuck detector Case (a) coord_exited_without_action ────

  it("§15.2 detector inserts retry coord (reason=coord_exited_without_action) when coord terminates with no children", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Terminal coord with no children → the in-tx detector fires
    // from inside `markNodeTerminal` itself and inserts a retry coord
    // before the wrapping primitive returns.
    await h.service.markNodeTerminal(workflowId, initialCoordNodeId, { status: "succeeded" });
    const dag = await h.service.getDag(workflowId);
    // 2 nodes now: the prev coord + the inserted retry coord.
    expect(dag.nodes.length).toBe(2);
    const retry = dag.nodes.find((n) => n.id !== initialCoordNodeId);
    expect(retry).toBeDefined();
    expect(retry?.kind).toBe("coordinator");
    // After the post-commit dispatch the stub coord runner records
    // the call and returns; the node may be `not_started`, `ready`,
    // or `running` depending on whether the engine's nudge has fired
    // through dispatchAtomic yet. None of the terminal statuses are
    // possible at this point.
    expect(retry?.status).not.toBe("succeeded");
    expect(retry?.status).not.toBe("failed");
    expect(retry?.status).not.toBe("cancelled");
    const meta = extractNodeRetryMetadata(retry!.metadata);
    expect(meta).toEqual({
      of: initialCoordNodeId,
      reason: "coord_exited_without_action",
      attempt: 1,
    });
    // Retry coord is a child of the prev coord (so the
    // OrphanCoordInsertError invariant is satisfied).
    expect(dag.edges.some((e) => e.from === initialCoordNodeId && e.to === retry?.id)).toBe(true);
  });

  // ─── 15.3 — Stuck detector Case (b) workers_finished_without_coord ─

  it("§15.3 detector inserts retry coord (reason=workers_finished_without_coord) with prev_coord in parents", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Coord adds two workers, then terminates without scheduling a
    // successor coord.
    const { nodeId: w1 } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "w1" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: w2 } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "w2" },
      parents: [initialCoordNodeId],
    });
    await h.service.markNodeTerminal(workflowId, initialCoordNodeId, { status: "succeeded" });
    await h.service.markNodeTerminal(workflowId, w1, { status: "succeeded" });
    // After w2 terminates, leaves = {w1, w2} (both workers) → reason
    // is workers_finished_without_coord. The detector inserts a
    // retry coord with parents = uniqueOrdered([prevCoord, w1, w2]) —
    // prevCoord MUST be first so OrphanCoordInsertError invariant is
    // satisfied even when leaves are all workers.
    await h.service.markNodeTerminal(workflowId, w2, { status: "succeeded" });
    const dag = await h.service.getDag(workflowId);
    const retry = dag.nodes.find((n) => n.kind === "coordinator" && n.id !== initialCoordNodeId);
    expect(retry).toBeDefined();
    const meta = extractNodeRetryMetadata(retry!.metadata);
    expect(meta).toEqual({
      of: initialCoordNodeId,
      reason: "workers_finished_without_coord",
      attempt: 1,
    });
    const retryParents = dag.edges.filter((e) => e.to === retry?.id).map((e) => e.from);
    expect(retryParents.sort()).toEqual([initialCoordNodeId, w1, w2].sort());
  });

  // ─── 15.4 — Attempt counter ratchets across recoveries ─────────────

  it("§15.4 attempt counter increments across multiple recoveries", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // 1st recovery: prev coord exits empty → retry coord attempt=1.
    await h.service.markNodeTerminal(workflowId, initialCoordNodeId, { status: "succeeded" });
    let dag = await h.service.getDag(workflowId);
    const retry1 = dag.nodes.find((n) => n.id !== initialCoordNodeId);
    expect(extractNodeRetryMetadata(retry1!.metadata)?.attempt).toBe(1);
    // 2nd recovery: retry1 exits empty → retry coord attempt=2.
    await h.service.markNodeTerminal(workflowId, retry1!.id, { status: "succeeded" });
    dag = await h.service.getDag(workflowId);
    const retry2 = dag.nodes.find((n) => n.id !== initialCoordNodeId && n.id !== retry1?.id);
    expect(extractNodeRetryMetadata(retry2!.metadata)?.attempt).toBe(2);
    // 3rd recovery: retry2 exits empty → retry coord attempt=3.
    await h.service.markNodeTerminal(workflowId, retry2!.id, { status: "succeeded" });
    dag = await h.service.getDag(workflowId);
    const retry3 = dag.nodes.find(
      (n) => n.id !== initialCoordNodeId && n.id !== retry1?.id && n.id !== retry2?.id,
    );
    expect(extractNodeRetryMetadata(retry3!.metadata)?.attempt).toBe(3);
  });

  // ─── 15.5 — Public recoverStuck on a non-stuck workflow ────────────

  it("§15.5 recoverStuck returns {inserted:false} on a fresh workflow with a running coord", async () => {
    const { workflowId } = await bootstrap(h);
    const result = await h.service.recoverStuck(workflowId);
    expect(result).toEqual({ workflowId, inserted: false });
    // No retry coord was inserted; the DAG still has exactly one node.
    const dag = await h.service.getDag(workflowId);
    expect(dag.nodes.length).toBe(1);
  });

  // ─── 15.6 — Detector skips terminal workflows ──────────────────────

  it("§15.6 detector skips a workflow that has already been cancelled", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await h.service.cancelWorkflow({
      workflowId,
      cancellation: { kind: "user", message: "" },
    });
    // Cancel reconciled the coord; the workflow is terminal. The
    // explicit recoverStuck path MUST be a no-op even though the
    // structural state (terminal nodes) would have looked stuck.
    const result = await h.service.recoverStuck(workflowId);
    expect(result).toEqual({ workflowId, inserted: false });
    const dag = await h.service.getDag(workflowId);
    // No retry coord was inserted; only the original coord remains.
    expect(dag.nodes.length).toBe(1);
    expect(dag.nodes[0]!.id).toBe(initialCoordNodeId);
  });

  // ─── 15.7 — Detector skips workflows with non-terminal nodes ───────

  it("§15.7 detector skips when any node is still not_started / ready / running", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Add a not_started worker; coord is still running. The detector
    // requires ALL nodes terminal before considering recovery — a
    // pending worker is not a stuck shape.
    await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "pending" },
      parents: [initialCoordNodeId],
    });
    const result = await h.service.recoverStuck(workflowId);
    expect(result).toEqual({ workflowId, inserted: false });
  });

  // ─── 15.8 — recoverStuck on a stuck workflow inserts retry ─────────

  it("§15.8 recoverStuck inserts a retry coord on a stuck workflow (idempotent on second call)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Drive the coord to terminal IN A WAY THAT BYPASSES the detector
    // hook on markNodeTerminal (use repo-level write inside a tx so
    // the service-level detector doesn't run). After this, the
    // explicit recoverStuck call should observe the stuck state and
    // insert a retry.
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: initialCoordNodeId,
        status: "succeeded",
        endedAt: "2026-06-07T00:00:01.000Z",
      });
    });
    const result1 = await h.service.recoverStuck(workflowId);
    expect(result1.inserted).toBe(true);
    if (!result1.inserted) throw new Error("unreachable");
    expect(result1.reason).toBe("coord_exited_without_action");
    expect(result1.attempt).toBe(1);
    // Second call is a no-op — the inserted retry coord is now a
    // non-terminal leaf, so the workflow is not stuck.
    const result2 = await h.service.recoverStuck(workflowId);
    expect(result2).toEqual({ workflowId, inserted: false });
  });

  // ─── 15.9 — recoverStuckAll skips terminal + non-stuck workflows ───

  it("§15.9 recoverStuckAll only recovers running stuck workflows", async () => {
    // Workflow A: running, stuck — should be recovered.
    const { workflowId: wfA, initialCoordNodeId: coordA } = await bootstrap(h, {
      brief: "A",
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: coordA,
        status: "succeeded",
        endedAt: "2026-06-07T00:00:01.000Z",
      });
    });
    // Workflow B: running, not stuck — should be skipped.
    const { workflowId: wfB } = await bootstrap(h, { brief: "B" });
    // Workflow C: terminal (cancelled) — should be skipped.
    const { workflowId: wfC } = await bootstrap(h, { brief: "C" });
    await h.service.cancelWorkflow({
      workflowId: wfC,
      cancellation: { kind: "user", message: "" },
    });
    const results = await h.service.recoverStuckAll();
    const byId = new Map(results.map((r) => [r.workflowId, r]));
    expect(byId.get(wfA)?.inserted).toBe(true);
    expect(byId.get(wfB)?.inserted).toBe(false);
    // wfC was already terminal at scan time — `recoverStuckAll`
    // filters out non-running workflows before invoking the
    // detector, so it doesn't appear in the result list at all.
    expect(byId.has(wfC)).toBe(false);
  });

  // ─── 15.10 — Workflow denorm `coordinator_agent` mirrors retry coord ─

  it("§15.10 retry-coord insertion refreshes workflows.coordinator_agent denorm", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h, {
      coordinatorAgent: "coord-v1",
    });
    expect((await h.service.getWorkflow(workflowId)).coordinatorAgent).toBe("coord-v1");
    // Drive to stuck and trigger explicit recovery.
    await h.service.markNodeTerminal(workflowId, initialCoordNodeId, { status: "succeeded" });
    // Substrate copies prev coord's agent verbatim into the retry
    // coord's spec, then refreshes the denorm to match.
    expect((await h.service.getWorkflow(workflowId)).coordinatorAgent).toBe("coord-v1");
  });

  // ─── 15.11 — Retry attempt cap (defensive safety net) ──────────────

  it("§15.11 detector stops inserting retry coords after STUCK_RETRY_MAX_ATTEMPTS (5)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Drive 5 successful retry-coord insertions: terminate the
    // initial coord, then each retry, in sequence. After the cap
    // (5) any further terminal would otherwise produce attempt=6 —
    // the detector logs a warning and returns inserted=false instead.
    let prevId = initialCoordNodeId;
    for (let i = 1; i <= 5; i++) {
      await h.service.markNodeTerminal(workflowId, prevId, { status: "succeeded" });
      const dag = await h.service.getDag(workflowId);
      // Pick the newest coord (the one whose retry.attempt matches i).
      const next = dag.nodes.find((n) => {
        const meta = extractNodeRetryMetadata(n.metadata);
        return meta !== undefined && meta.attempt === i;
      });
      expect(next).toBeDefined();
      prevId = next!.id;
    }
    // 6th terminal: the detector hits the cap and returns no-op. The
    // DAG node count stays at 6 (initial + 5 retries) — no 7th node.
    await h.service.markNodeTerminal(workflowId, prevId, { status: "succeeded" });
    const dag = await h.service.getDag(workflowId);
    expect(dag.nodes.length).toBe(6);
  });
});
