import type {
  CreateWorkflowBody,
  WorkflowDagWire,
  WorkflowEdgeWire,
  WorkflowHeaderWire,
  WorkflowListQuery,
  WorkflowNodeWire,
  WorkflowNodeWireSpec,
} from "@emploke/contracts";
import { fetchJson, jsonInit, mutateJson, workspacePrefix } from "./http.js";

export type {
  CreateWorkflowBody,
  WorkflowDagWire,
  WorkflowEdgeWire,
  WorkflowHeaderWire,
  WorkflowListQuery,
  WorkflowNodeWire,
  WorkflowNodeWireSpec,
};

/**
 * Body for `POST /workflows/:wfid/cancel`. The server currently
 * discards the body (`#331` spec line 328 — cancel is body-less in
 * M2) but we keep the local DTO so the dashboard sends the user's
 * optional cancel reason for forward-compat with `#334` (the
 * substrate gap that will surface a structured cancel reason).
 * Marked dashboard-internal because the contracts package does not
 * yet model this body.
 */
export interface CancelWorkflowBody {
  readonly reason?: string;
}

export const listWorkflows = (
  opts: WorkflowListQuery = {},
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
