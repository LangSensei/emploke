/**
 * `TaskRepository.findTaskByWorkflowNode(nodeId)` is the read used
 * by the wire-shape projector to enrich `WorkflowNodeWire.taskId`
 * for the workflow `/dag` route. Powers the dashboard's Mode B
 * node drill-down — clicking a node navigates to its dispatched
 * task. Differs from {@link TaskRepository.listInFlightForWorkflowNode}
 * by surfacing terminal tasks too and capping to the most recent
 * row when several were dispatched (e.g. a re-dispatch after
 * cancel).
 *
 * Predicate is `origin = 'workflow' AND metadata.workflowNodeId = ?`
 * ordered by `createdAt DESC LIMIT 1`. The origin guard
 * discriminates: a standalone task that happens to carry
 * `metadata.workflowNodeId` does NOT count.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskEntity } from "../src/task-entity.js";
import { TaskRepository } from "../src/task-repository.js";
import { openTestTaskDb } from "../src/testing.js";
import type {
  TaskCancellation,
  TaskFailure,
  TaskOrigin,
  TaskStatus,
  TaskSuccess,
} from "../src/types.js";

let orm: ReturnType<typeof openTestTaskDb>;
let repo: TaskRepository;

beforeEach(() => {
  orm = openTestTaskDb();
  repo = new TaskRepository({ db: orm.db });
});
afterEach(() => {
  orm.close();
});

async function seed(args: {
  id: string;
  origin: TaskOrigin;
  status: TaskStatus;
  workflowNodeId?: string;
  createdAt?: string;
  success?: TaskSuccess;
  failure?: TaskFailure;
  cancellation?: TaskCancellation;
}): Promise<void> {
  const metadata: Record<string, unknown> = {};
  if (args.workflowNodeId !== undefined) metadata.workflowNodeId = args.workflowNodeId;
  const createdAt = args.createdAt ?? "2026-05-19T01:00:00.000Z";
  await repo.save(
    TaskEntity.fromStored({
      id: args.id,
      agent: "demo",
      brief: "b",
      origin: args.origin,
      status: args.status,
      metadata,
      createdAt,
      startedAt: createdAt,
      ...(args.status !== "running" ? { endedAt: "2026-05-19T02:00:00.000Z" } : {}),
      ...(args.success !== undefined ? { success: args.success } : {}),
      ...(args.failure !== undefined ? { failure: args.failure } : {}),
      ...(args.cancellation !== undefined ? { cancellation: args.cancellation } : {}),
    }),
  );
}

describe("TaskRepository.findTaskByWorkflowNode", () => {
  it("returns the task for a non-terminal (running) worker node", async () => {
    await seed({
      id: "20260519-aaaaaaaa",
      origin: "workflow",
      status: "running",
      workflowNodeId: "wfn-1",
    });
    const found = await repo.findTaskByWorkflowNode("wfn-1");
    expect(found?.id).toBe("20260519-aaaaaaaa");
    expect(found?.status).toBe("running");
  });

  it("returns the task for a terminal-succeeded worker node (no in-flight filter)", async () => {
    await seed({
      id: "20260519-bbbbbbbb",
      origin: "workflow",
      status: "succeeded",
      workflowNodeId: "wfn-2",
      success: { output: "ok" },
    });
    const found = await repo.findTaskByWorkflowNode("wfn-2");
    expect(found?.id).toBe("20260519-bbbbbbbb");
    expect(found?.status).toBe("succeeded");
  });

  it("returns null when no task exists for the nodeId", async () => {
    const found = await repo.findTaskByWorkflowNode("wfn-none");
    expect(found).toBeNull();
  });

  it("returns null when only a standalone task carries the same workflowNodeId (origin guard)", async () => {
    await seed({
      id: "20260519-cccccccc",
      origin: "standalone",
      status: "running",
      workflowNodeId: "wfn-3",
    });
    expect(await repo.findTaskByWorkflowNode("wfn-3")).toBeNull();
  });

  it("returns the most recent row when several tasks share a workflowNodeId (re-dispatch case)", async () => {
    // Earlier task — cancelled.
    await seed({
      id: "20260519-dddddddd",
      origin: "workflow",
      status: "cancelled",
      workflowNodeId: "wfn-4",
      createdAt: "2026-05-19T01:00:00.000Z",
      cancellation: { kind: "user", message: "stop" },
    });
    // Later re-dispatch.
    await seed({
      id: "20260519-eeeeeeee",
      origin: "workflow",
      status: "running",
      workflowNodeId: "wfn-4",
      createdAt: "2026-05-19T03:00:00.000Z",
    });
    const found = await repo.findTaskByWorkflowNode("wfn-4");
    expect(found?.id).toBe("20260519-eeeeeeee");
    expect(found?.status).toBe("running");
  });
});
