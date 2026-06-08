// Workflow wire DTOs — keep in sync with packages/contracts/src/workflows.ts.
// Imported locally here while the contracts package addition is in flight on a parallel branch.
export interface WorkflowHeaderWire {
  readonly id: string;
  readonly brief: string;
  readonly details?: string;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly coordinatorAgent: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly outcomeReason?: string;
  readonly iterationCount: number;
}

export type WorkflowNodeWireSpec =
  | { readonly kind: "coordinator"; readonly agent: string }
  | {
      readonly kind: "task";
      readonly agent: string;
      readonly brief: string;
      readonly details?: string;
      readonly runtime?: string;
    }
  | { readonly kind: string; readonly spec: unknown };

export interface WorkflowNodeWire {
  readonly id: string;
  readonly workflowId: string;
  readonly kind: "coordinator" | "task";
  readonly status: "ready" | "running" | "succeeded" | "failed" | "cancelled";
  readonly phase: number;
  readonly spec: WorkflowNodeWireSpec;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly outcomeReason?: string;
}

export interface WorkflowEdgeWire {
  readonly from: string;
  readonly to: string;
}

export interface WorkflowDagWire {
  readonly workflow: WorkflowHeaderWire;
  readonly nodes: readonly WorkflowNodeWire[];
  readonly edges: readonly WorkflowEdgeWire[];
}

export interface CreateWorkflowBody {
  readonly brief: string;
  readonly details?: string;
  readonly coordinatorAgent: string;
}

export interface ListWorkflowsOpts {
  readonly status?: "running" | "succeeded" | "failed" | "cancelled";
}

export interface CancelWorkflowBody {
  readonly reason?: string;
}

import { fetchJson, jsonInit, mutateJson, workspacePrefix } from "./http.js";

export const listWorkflows = (
  opts: ListWorkflowsOpts = {},
): Promise<readonly WorkflowHeaderWire[]> => {
  const qs = new URLSearchParams();
  if (opts.status !== undefined) qs.set("status", opts.status);
  const suffix = qs.toString() === "" ? "" : `?${qs.toString()}`;
  return fetchJson<readonly WorkflowHeaderWire[]>(
    `${workspacePrefix()}/workflows${suffix}`,
    "workflows",
  );
};

export const getWorkflow = (id: string): Promise<WorkflowHeaderWire> =>
  fetchJson<WorkflowHeaderWire>(
    `${workspacePrefix()}/workflows/${encodeURIComponent(id)}`,
    "workflow",
  );

export const getWorkflowDag = (id: string): Promise<WorkflowDagWire> =>
  fetchJson<WorkflowDagWire>(
    `${workspacePrefix()}/workflows/${encodeURIComponent(id)}/dag`,
    "workflow dag",
  );

export const createWorkflow = (body: CreateWorkflowBody): Promise<WorkflowHeaderWire> =>
  mutateJson<WorkflowHeaderWire>(`${workspacePrefix()}/workflows`, jsonInit("POST", body));

export const cancelWorkflow = (
  id: string,
  body: CancelWorkflowBody = {},
): Promise<WorkflowHeaderWire> =>
  mutateJson<WorkflowHeaderWire>(
    `${workspacePrefix()}/workflows/${encodeURIComponent(id)}/cancel`,
    jsonInit("POST", body),
  );
