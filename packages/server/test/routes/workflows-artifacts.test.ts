/**
 * Route-level tests for the workflow artifact endpoints in
 * `routes/workflows.ts`:
 *   - `GET /:wfid/artifacts`             — list
 *   - `GET /:wfid/artifacts/:encodedPath` — static bytes
 *
 * Disk fixtures live in an OS tempdir per `it()` (the listFilesRecursive
 * walk reads real `readdir`/`stat`; mocking the fs module would be more
 * fragile than just touching a few files).
 *
 * `findTaskByWorkflowNode` is stubbed at the resolver boundary so we
 * don't have to spin up the task-service db; the listing code only
 * needs `{ id }`.
 *
 * Coverage:
 *  1. list returns workflow-summary entries with `kind: "workflow-summary"`
 *  2. list returns per-node entries with kind/nodeId/taskId/mimeBucket
 *  3. list returns `{ artifacts: [] }` when both namespaces are empty
 *  4. list 404s when getDag rejects with WorkflowNotFoundError
 *  5. GET summary/<name> streams bytes with `Cache-Control: no-store`
 *  6. GET nodes/<nid>/<name> streams bytes with `Cache-Control: max-age=300`
 *  7. GET nodes/<nid>/<name> 404s when no task is dispatched
 *  8. GET …/..%2F… (traversal) rejects with 400
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkflowDagSnapshot } from "@emploke/workflow";
import {
  WorkflowEdgeEntity,
  WorkflowEntity,
  WorkflowNodeEntity,
  WorkflowNotFoundError,
  type WorkflowService,
} from "@emploke/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workflowsRoutes } from "../../src/routes/workflows.js";

const WID = "550e8400-e29b-41d4-a716-446655440000";
const COORD_NID = "550e8400-e29b-41d4-a716-446655440001";
const WORKER_NID = "550e8400-e29b-41d4-a716-446655440002";
const WORKER_TID = "20260607-aaaa1111";

function makeHeader(): WorkflowEntity {
  return WorkflowEntity.fromRow({
    id: WID,
    brief: "ship feature X",
    details: null,
    coordinatorAgent: "coord-agent",
    status: "running",
    metadata: "{}",
    createdAt: "2026-06-07T00:00:00.000Z",
    startedAt: "2026-06-07T00:00:00.000Z",
    endedAt: null,
  });
}

function makeCoord(): WorkflowNodeEntity {
  return WorkflowNodeEntity.fromRow({
    id: COORD_NID,
    workflowId: WID,
    kind: "coordinator",
    specJson: JSON.stringify({ agent: "coord-agent" }),
    phase: 0,
    status: "running",
    createdAt: "2026-06-07T00:00:00.000Z",
    readyAt: "2026-06-07T00:00:00.000Z",
    runningAt: "2026-06-07T00:00:00.000Z",
    endedAt: null,
  });
}

function makeWorker(): WorkflowNodeEntity {
  return WorkflowNodeEntity.fromRow({
    id: WORKER_NID,
    workflowId: WID,
    kind: "worker",
    specJson: JSON.stringify({ agent: "writer", brief: "draft" }),
    phase: 1,
    status: "succeeded",
    createdAt: "2026-06-07T00:00:01.000Z",
    readyAt: "2026-06-07T00:00:01.000Z",
    runningAt: "2026-06-07T00:00:02.000Z",
    endedAt: "2026-06-07T00:00:03.000Z",
  });
}

function makeDag(): WorkflowDagSnapshot {
  return {
    workflow: makeHeader(),
    nodes: [makeCoord(), makeWorker()],
    edges: [
      WorkflowEdgeEntity.fromRow({ workflowId: WID, fromNodeId: COORD_NID, toNodeId: WORKER_NID }),
    ],
  };
}

function stubService(overrides: Partial<Record<keyof WorkflowService, unknown>>): WorkflowService {
  const stub: Partial<Record<keyof WorkflowService, unknown>> = {
    getDag: vi.fn(async () => makeDag()),
    ...overrides,
  };
  return stub as unknown as WorkflowService;
}

interface TaskStub {
  findTaskByWorkflowNode: (nodeId: string) => Promise<{ readonly id: string } | null>;
}

function stubTasks(map: Record<string, string | null>): TaskStub {
  return {
    findTaskByWorkflowNode: async (nodeId: string) => {
      const id = map[nodeId];
      if (id === undefined || id === null) return null;
      return { id };
    },
  };
}

function mountRoutes(svc: WorkflowService, tasks: TaskStub, workspaceDir: string) {
  return workflowsRoutes(
    () => svc,
    () => tasks as unknown as import("@emploke/task").TaskService,
    () => workspaceDir,
  );
}

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(tmpdir(), "wf-artifacts-test-"));
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

async function writeFileAt(dir: string, name: string, body: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), body, "utf8");
}

describe("workflowsRoutes — artifacts list", () => {
  it("returns workflow-summary entries with mimeBucket", async () => {
    await writeFileAt(path.join(workspaceDir, "workflows", WID, "artifact"), "report.md", "# hi");
    await writeFileAt(
      path.join(workspaceDir, "workflows", WID, "artifact"),
      "chart.png",
      "fake-png",
    );

    const svc = stubService({});
    const tasks = stubTasks({});
    const res = await mountRoutes(svc, tasks, workspaceDir).request(`/${WID}/artifacts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: Array<Record<string, unknown>> };
    const summaries = body.artifacts.filter((a) => a.kind === "workflow-summary");
    expect(summaries).toHaveLength(2);
    const reportEntry = summaries.find((a) => a.path === "report.md");
    expect(reportEntry?.mimeBucket).toBe("text");
    const chartEntry = summaries.find((a) => a.path === "chart.png");
    expect(chartEntry?.mimeBucket).toBe("image");
  });

  it("returns per-node entries enriched with taskId + nodeId", async () => {
    await writeFileAt(
      path.join(workspaceDir, "tasks", WORKER_TID, "artifact"),
      "result.json",
      "{}",
    );
    const svc = stubService({});
    const tasks = stubTasks({ [WORKER_NID]: WORKER_TID });
    const res = await mountRoutes(svc, tasks, workspaceDir).request(`/${WID}/artifacts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: Array<Record<string, unknown>> };
    const nodeEntries = body.artifacts.filter((a) => a.kind === "node");
    expect(nodeEntries).toHaveLength(1);
    expect(nodeEntries[0]?.nodeId).toBe(WORKER_NID);
    expect(nodeEntries[0]?.taskId).toBe(WORKER_TID);
    expect(nodeEntries[0]?.path).toBe("result.json");
    expect(nodeEntries[0]?.mimeBucket).toBe("text");
  });

  it("returns an empty array when both namespaces are empty", async () => {
    const svc = stubService({});
    const tasks = stubTasks({});
    const res = await mountRoutes(svc, tasks, workspaceDir).request(`/${WID}/artifacts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: unknown[] };
    expect(body.artifacts).toEqual([]);
  });

  it("404s when the workflow id is unknown", async () => {
    const svc = stubService({
      getDag: vi.fn(async () => {
        throw new WorkflowNotFoundError(WID);
      }),
    });
    const tasks = stubTasks({});
    const res = await mountRoutes(svc, tasks, workspaceDir).request(`/${WID}/artifacts`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("WorkflowNotFoundError");
  });
});

describe("workflowsRoutes — artifacts bytes", () => {
  it("streams summary bytes with Cache-Control: no-store", async () => {
    await writeFileAt(
      path.join(workspaceDir, "workflows", WID, "artifact"),
      "report.md",
      "# hello world",
    );
    const svc = stubService({});
    const tasks = stubTasks({});
    const encoded = encodeURIComponent("summary/report.md");
    const res = await mountRoutes(svc, tasks, workspaceDir).request(`/${WID}/artifacts/${encoded}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toMatch(/text\/markdown/);
    const text = await res.text();
    expect(text).toBe("# hello world");
  });

  it("streams node bytes with Cache-Control: max-age=300", async () => {
    await writeFileAt(
      path.join(workspaceDir, "tasks", WORKER_TID, "artifact"),
      "out.txt",
      "result",
    );
    const svc = stubService({});
    const tasks = stubTasks({ [WORKER_NID]: WORKER_TID });
    const encoded = encodeURIComponent(`nodes/${WORKER_NID}/out.txt`);
    const res = await mountRoutes(svc, tasks, workspaceDir).request(`/${WID}/artifacts/${encoded}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("max-age=300");
    const text = await res.text();
    expect(text).toBe("result");
  });

  it("404s when no task is dispatched for the node", async () => {
    const svc = stubService({});
    const tasks = stubTasks({}); // empty map → null lookup
    const encoded = encodeURIComponent(`nodes/${WORKER_NID}/out.txt`);
    const res = await mountRoutes(svc, tasks, workspaceDir).request(`/${WID}/artifacts/${encoded}`);
    expect(res.status).toBe(404);
  });

  it("rejects traversal attempts in the artifact path with 400", async () => {
    const svc = stubService({});
    const tasks = stubTasks({});
    const encoded = encodeURIComponent("summary/../../escape.md");
    const res = await mountRoutes(svc, tasks, workspaceDir).request(`/${WID}/artifacts/${encoded}`);
    expect(res.status).toBe(400);
  });
});
