import type {
  CancelWorkflowBody,
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
  CancelWorkflowBody,
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

export const listWorkflows = (
  opts: WorkflowListQuery = {},
): Promise<readonly WorkflowHeaderWire[]> => {
  const qs = new URLSearchParams();
  if (opts.q !== undefined && opts.q !== "") qs.set("q", opts.q);
  if (opts.coordinatorAgent !== undefined && opts.coordinatorAgent !== "") {
    qs.set("coordinatorAgent", opts.coordinatorAgent);
  }
  if (opts.createdSince !== undefined) qs.set("createdSince", opts.createdSince);
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

/**
 * Cancel a workflow. The v2.2 wire shape requires a
 * `cancellation: { message }` body; the dashboard always sends `kind:
 * "user"` (the only kind operator-driven cancels emit). Empty message
 * is allowed but the `cancellation` object itself is required.
 */
export const cancelWorkflow = (id: string, body: CancelWorkflowBody): Promise<WorkflowHeaderWire> =>
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
