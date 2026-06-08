import type {
  CreateWorkflowBody,
  WorkflowArtifactsResponse,
  WorkflowArtifactWire,
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
  WorkflowArtifactsResponse,
  WorkflowArtifactWire,
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

/**
 * Workflow artifact list. Returns an aggregated `{ artifacts: [] }`
 * response covering both the curated workflow-summary namespace
 * (`<workflowDir>/artifact/`) and per-node artifact namespaces
 * (`<tasksRoot>/<taskId>/artifact/`).
 *
 * The contracts type is the source of truth for the wire shape.
 */
export const listWorkflowArtifacts = (id: string): Promise<WorkflowArtifactsResponse> =>
  fetchJson<WorkflowArtifactsResponse>(
    `${workspacePrefix()}/workflows/${encodeURIComponent(id)}/artifacts`,
    "workflow artifacts",
  );

/**
 * URL builder for the single-artifact static-bytes endpoint. The
 * caller passes a sentinel-prefixed sub-path:
 *
 *   - `summary/<rest>`           — workflow-summary artifact
 *   - `nodes/<nodeId>/<rest>`    — per-node artifact
 *
 * The whole sub-path is `encodeURIComponent`-d so `/` becomes `%2F`
 * (the server reads it as one Hono path segment). Callers use this
 * URL for `<img src>` / `<a href>` / `<iframe src>` without any
 * additional `fetch` wrapping.
 */
export const workflowArtifactUrl = (id: string, subPath: string): string =>
  `${workspacePrefix()}/workflows/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(subPath)}`;
