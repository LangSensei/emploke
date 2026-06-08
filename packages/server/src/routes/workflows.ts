/**
 * Routes for `/api/workspaces/:id/workflows`. Workspace-scoped read
 * + lifecycle + coord-callback mutation surface over `WorkflowService`.
 * The substrate is kind-agnostic and stores nodes opaquely as
 * `{ kind, spec: unknown }`; the wire-layer projection
 * (`_workflow-projection.ts`) flattens the per-kind shapes for the
 * dashboard / CLI.
 *
 * Resolver-injection pattern matches `routes/schedules.ts` /
 * `routes/tasks.ts`: the mount point in `server/src/index.ts` hands
 * in a function that pulls the workspace-scoped `WorkflowService`
 * out of Hono's per-request context. The route file never touches
 * workspace resolution, only the workflow surface.
 *
 * ## Endpoints
 *
 *   - `GET    /`                      — list workflows; `?status=` narrows
 *   - `POST   /`                      — seed a workflow + its initial coord
 *   - `GET    /:wfid`                 — header only (with `iterationCount`)
 *   - `GET    /:wfid/dag`             — full snapshot (header + nodes + edges)
 *   - `POST   /:wfid/cancel`          — external cancel; returns updated header
 *   - `POST   /:wfid/nodes`           — add a single node (M2.5)
 *   - `POST   /:wfid/edges`           — add a single edge (M2.5)
 *   - `POST   /:wfid/subgraph`        — batch insert N nodes + M edges (M2.5)
 *   - `POST   /:wfid/nodes/:nid/cancel` — cancel a worker-kind node (M2.5)
 *   - `POST   /:wfid/finish`          — flip workflow terminal (M2.5)
 *   - `DELETE /:wfid/nodes/:nid`      — delete a not_started node (M2.5)
 *   - `DELETE /:wfid/edges/:from/:to` — delete a not_started edge (M2.5)
 *   - `PATCH  /:wfid/nodes/:nid/spec` — re-validate + replace spec (M2.5)
 *
 * ## Auth gate (mutation routes)
 *
 * Every mutation route forwards `workflowId` from the URL path and
 * NOTHING ELSE about the caller. The substrate derives the calling
 * coordinator (the unique `kind='coordinator' AND status='running'`
 * row in this workflow) inside its mutation tx. A request that does
 * not originate from inside a coord task gets
 * `WorkflowMutationUnauthorizedError` → 403 from the policy below.
 *
 * ## iterationCount derivation
 *
 *   - `GET /`     — projected as `0` per row to keep the endpoint
 *                   O(workflows). Computing the true value would
 *                   require a per-row coord-count query (N+1). Clients
 *                   that need the accurate count fetch the header.
 *   - `GET /:wfid` and `GET /:wfid/dag` — derived from the workflow's
 *                   coord-node count via `deriveIterationCount`.
 *
 * ## Cancel response
 *
 * `cancelWorkflow` returns `Promise<void>`; the route does a second
 * `getDag` after the cancel to project the post-cancel header (so
 * the caller observes the new `endedAt` / `status` without a second
 * round-trip).
 */

import type {
  AddEdgeBody,
  AddNodeBody,
  AddSubgraphBody,
  AddSubgraphEdgeInputWire,
  AddSubgraphNodeInputWire,
  CreateWorkflowBody,
  FinishWorkflowBody,
  NodeRefWire,
  ReplaceNodeSpecBody,
  WorkflowDagWire,
  WorkflowHeaderWire,
  WorkflowStatusWire,
} from "@emploke/api";
import {
  type NodeKind,
  type NodeRef,
  WorkflowError,
  type WorkflowService,
  type WorkflowStatus,
} from "@emploke/workflow";
import { Hono } from "hono";
import { workflowsErrorPolicy } from "./_error-policies/workflows.js";
import { respondError } from "./_respond-error.js";
import { errorBody, logEvent, parseJsonBody } from "./_shared.js";
import {
  iterationCountForNodes,
  projectWorkflowDag,
  projectWorkflowHeader,
  projectWorkflowNode,
} from "./_workflow-projection.js";

export type WorkflowServiceResolver = (c: import("hono").Context) => WorkflowService;

const ALLOWED_CREATE_KEYS = new Set(["brief", "details", "coordinatorAgent", "metadata"]);
const KNOWN_STATUSES: readonly WorkflowStatus[] = ["running", "succeeded", "failed", "cancelled"];
const KNOWN_NODE_KINDS: readonly NodeKind[] = ["coordinator", "worker"];
const KNOWN_FINISH_OUTCOMES: readonly ("succeeded" | "failed")[] = ["succeeded", "failed"];

interface ValidationFail {
  readonly ok: false;
  readonly error: string;
}
interface ValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}
type ValidationResult<T> = ValidationOk<T> | ValidationFail;

function validateStatusQuery(
  raw: string | undefined,
): ValidationResult<WorkflowStatus | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!KNOWN_STATUSES.includes(raw as WorkflowStatus)) {
    return {
      ok: false,
      error: `status must be one of: ${KNOWN_STATUSES.join(", ")}`,
    };
  }
  return { ok: true, value: raw as WorkflowStatus };
}

function validateCreateBody(raw: unknown): ValidationResult<CreateWorkflowBody> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "request body must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_CREATE_KEYS.has(k)) {
      return { ok: false, error: `request body has unknown key "${k}"` };
    }
  }
  const { brief, details, coordinatorAgent, metadata } = obj;
  if (typeof brief !== "string" || brief.trim().length === 0) {
    return { ok: false, error: "brief must be a non-empty string" };
  }
  if (typeof coordinatorAgent !== "string" || coordinatorAgent.trim().length === 0) {
    return { ok: false, error: "coordinatorAgent must be a non-empty string" };
  }
  if (details !== undefined && typeof details !== "string") {
    return { ok: false, error: "details, when set, must be a string" };
  }
  if (metadata !== undefined) {
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      return { ok: false, error: "metadata, when set, must be a JSON object" };
    }
  }
  return {
    ok: true,
    value: {
      brief,
      coordinatorAgent,
      ...(details !== undefined ? { details } : {}),
      ...(metadata !== undefined
        ? { metadata: metadata as Readonly<Record<string, unknown>> }
        : {}),
    },
  };
}

// ─── Mutation-route body validators ───────────────────────────────
//
// One validator per mutation primitive that takes a body. Each one
// rejects the cheap shape errors at the boundary (unknown keys, wrong
// types, missing required fields) so the substrate sees only inputs
// that are at least *structurally* sane. Domain rules (parent-state,
// cycle, kind enum) are the substrate's job — these validators MUST
// NOT pre-check anything the substrate already validates, or the
// caller would observe two distinct rejection paths for the same
// invariant.

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function validateAddNodeBody(raw: unknown): ValidationResult<AddNodeBody> {
  if (!isPlainObject(raw)) return { ok: false, error: "request body must be an object" };
  const allowed = new Set(["kind", "spec", "parents"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) return { ok: false, error: `request body has unknown key "${k}"` };
  }
  const { kind, spec, parents } = raw;
  if (typeof kind !== "string" || !(KNOWN_NODE_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      error: `kind must be one of: ${KNOWN_NODE_KINDS.join(", ")}`,
    };
  }
  if (spec === undefined) return { ok: false, error: "spec is required" };
  if (!Array.isArray(parents)) return { ok: false, error: "parents must be an array of strings" };
  for (const p of parents) {
    if (typeof p !== "string" || p.length === 0) {
      return { ok: false, error: "parents entries must be non-empty strings" };
    }
  }
  return {
    ok: true,
    value: {
      kind: kind as AddNodeBody["kind"],
      spec,
      parents: parents as readonly string[],
    },
  };
}

function validateAddEdgeBody(raw: unknown): ValidationResult<AddEdgeBody> {
  if (!isPlainObject(raw)) return { ok: false, error: "request body must be an object" };
  const allowed = new Set(["fromNodeId", "toNodeId"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) return { ok: false, error: `request body has unknown key "${k}"` };
  }
  const { fromNodeId, toNodeId } = raw;
  if (typeof fromNodeId !== "string" || fromNodeId.length === 0) {
    return { ok: false, error: "fromNodeId must be a non-empty string" };
  }
  if (typeof toNodeId !== "string" || toNodeId.length === 0) {
    return { ok: false, error: "toNodeId must be a non-empty string" };
  }
  return { ok: true, value: { fromNodeId, toNodeId } };
}

function validateNodeRefWire(raw: unknown): ValidationResult<NodeRefWire> {
  if (!isPlainObject(raw)) return { ok: false, error: "ref must be an object" };
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    return { ok: false, error: 'ref must have exactly one key: "nodeId" OR "tempId"' };
  }
  if ("nodeId" in raw) {
    if (typeof raw.nodeId !== "string" || raw.nodeId.length === 0) {
      return { ok: false, error: "ref.nodeId must be a non-empty string" };
    }
    return { ok: true, value: { nodeId: raw.nodeId } };
  }
  if ("tempId" in raw) {
    if (typeof raw.tempId !== "string" || raw.tempId.length === 0) {
      return { ok: false, error: "ref.tempId must be a non-empty string" };
    }
    return { ok: true, value: { tempId: raw.tempId } };
  }
  return { ok: false, error: 'ref must have key "nodeId" OR "tempId"' };
}

function validateAddSubgraphBody(raw: unknown): ValidationResult<AddSubgraphBody> {
  if (!isPlainObject(raw)) return { ok: false, error: "request body must be an object" };
  const allowed = new Set(["nodes", "edges"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) return { ok: false, error: `request body has unknown key "${k}"` };
  }
  const { nodes, edges } = raw;
  if (!Array.isArray(nodes)) return { ok: false, error: "nodes must be an array" };
  if (!Array.isArray(edges)) return { ok: false, error: "edges must be an array" };
  const validNodes: AddSubgraphNodeInputWire[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (!isPlainObject(n)) return { ok: false, error: `nodes[${i}] must be an object` };
    const nAllowed = new Set(["tempId", "kind", "spec", "existingParents"]);
    for (const k of Object.keys(n)) {
      if (!nAllowed.has(k)) {
        return { ok: false, error: `nodes[${i}] has unknown key "${k}"` };
      }
    }
    if (typeof n.tempId !== "string" || n.tempId.length === 0) {
      return { ok: false, error: `nodes[${i}].tempId must be a non-empty string` };
    }
    if (typeof n.kind !== "string" || !(KNOWN_NODE_KINDS as readonly string[]).includes(n.kind)) {
      return {
        ok: false,
        error: `nodes[${i}].kind must be one of: ${KNOWN_NODE_KINDS.join(", ")}`,
      };
    }
    if (n.spec === undefined) {
      return { ok: false, error: `nodes[${i}].spec is required` };
    }
    let existingParents: readonly string[] | undefined;
    if (n.existingParents !== undefined) {
      if (!Array.isArray(n.existingParents)) {
        return { ok: false, error: `nodes[${i}].existingParents must be an array` };
      }
      for (const p of n.existingParents) {
        if (typeof p !== "string" || p.length === 0) {
          return {
            ok: false,
            error: `nodes[${i}].existingParents entries must be non-empty strings`,
          };
        }
      }
      existingParents = n.existingParents as readonly string[];
    }
    validNodes.push({
      tempId: n.tempId,
      kind: n.kind as AddSubgraphNodeInputWire["kind"],
      spec: n.spec,
      ...(existingParents !== undefined ? { existingParents } : {}),
    });
  }
  const validEdges: AddSubgraphEdgeInputWire[] = [];
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i];
    if (!isPlainObject(e)) return { ok: false, error: `edges[${i}] must be an object` };
    const eAllowed = new Set(["from", "to"]);
    for (const k of Object.keys(e)) {
      if (!eAllowed.has(k)) {
        return { ok: false, error: `edges[${i}] has unknown key "${k}"` };
      }
    }
    const fromResult = validateNodeRefWire(e.from);
    if (!fromResult.ok) return { ok: false, error: `edges[${i}].from: ${fromResult.error}` };
    const toResult = validateNodeRefWire(e.to);
    if (!toResult.ok) return { ok: false, error: `edges[${i}].to: ${toResult.error}` };
    validEdges.push({ from: fromResult.value, to: toResult.value });
  }
  return { ok: true, value: { nodes: validNodes, edges: validEdges } };
}

function validateReplaceNodeSpecBody(raw: unknown): ValidationResult<ReplaceNodeSpecBody> {
  if (!isPlainObject(raw)) return { ok: false, error: "request body must be an object" };
  const allowed = new Set(["newSpec"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) return { ok: false, error: `request body has unknown key "${k}"` };
  }
  if (raw.newSpec === undefined) return { ok: false, error: "newSpec is required" };
  return { ok: true, value: { newSpec: raw.newSpec } };
}

function validateFinishWorkflowBody(raw: unknown): ValidationResult<FinishWorkflowBody> {
  if (!isPlainObject(raw)) return { ok: false, error: "request body must be an object" };
  const allowed = new Set(["outcome"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) return { ok: false, error: `request body has unknown key "${k}"` };
  }
  const { outcome } = raw;
  if (
    typeof outcome !== "string" ||
    !(KNOWN_FINISH_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    return {
      ok: false,
      error: `outcome must be one of: ${KNOWN_FINISH_OUTCOMES.join(", ")}`,
    };
  }
  return { ok: true, value: { outcome: outcome as FinishWorkflowBody["outcome"] } };
}

/**
 * Translate the wire-shape {@link NodeRefWire} (structural-discriminator
 * union by `nodeId` vs `tempId` presence) to the substrate's
 * {@link NodeRef} (explicit-tag union). The wire form is JSON-friendly
 * (no extra discriminator field); the substrate form is type-friendly
 * (discriminated by `kind`). Pure projection — no validation here, the
 * caller has already proven the input is a valid wire shape.
 */
function nodeRefFromWire(ref: NodeRefWire): NodeRef {
  if ("nodeId" in ref) return { kind: "existing", id: ref.nodeId };
  return { kind: "temp", tempId: ref.tempId };
}

export function workflowsRoutes(resolve: WorkflowServiceResolver): Hono {
  const app = new Hono();

  // ── GET / — list with optional status filter ─────────────────────
  app.get("/", async (c) => {
    const statusResult = validateStatusQuery(c.req.query("status"));
    if (!statusResult.ok) {
      return c.json(errorBody(new WorkflowError(statusResult.error)), 400);
    }
    try {
      const list = await resolve(c).list(
        statusResult.value !== undefined ? { status: statusResult.value } : undefined,
      );
      // `iterationCount` projected as 0 on list rows to keep the
      // endpoint O(workflows). Clients that need the accurate count
      // fetch the header via `GET /:wfid`.
      const wire: readonly WorkflowHeaderWire[] = list.map((wf) => projectWorkflowHeader(wf, 0));
      return c.json(wire);
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.list",
        policy: workflowsErrorPolicy,
      });
    }
  });

  // ── POST / — seed a workflow + its initial coord ─────────────────
  app.post("/", async (c) => {
    const parsed = await parseJsonBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const validated = validateCreateBody(parsed.body);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const body = validated.value;
    try {
      const { workflowId } = await resolve(c).createWorkflow({
        brief: body.brief,
        coordinatorAgent: body.coordinatorAgent,
        ...(body.details !== undefined ? { details: body.details } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      });
      // A freshly seeded workflow has exactly one coord node, so
      // `iterationCount` is 1 (silent-retry coords are counted too —
      // a retry IS another iteration). Hard-coded rather than
      // rederived to avoid a second query on the happy path.
      const wf = await resolve(c).getWorkflow(workflowId);
      logEvent(c, "workflow.create", {
        workflowId,
        coordinatorAgent: body.coordinatorAgent,
      });
      return c.json(projectWorkflowHeader(wf, 1), 201);
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.create",
        policy: workflowsErrorPolicy,
      });
    }
  });

  // ── GET /:wfid — header only (with iterationCount) ───────────────
  app.get("/:wfid", async (c) => {
    const wfid = c.req.param("wfid");
    try {
      const dag = await resolve(c).getDag(wfid);
      const iter = iterationCountForNodes(dag.nodes);
      return c.json(projectWorkflowHeader(dag.workflow, iter));
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.get",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid },
      });
    }
  });

  // ── GET /:wfid/dag — full snapshot ───────────────────────────────
  app.get("/:wfid/dag", async (c) => {
    const wfid = c.req.param("wfid");
    try {
      const snapshot = await resolve(c).getDag(wfid);
      const wire: WorkflowDagWire = projectWorkflowDag(snapshot);
      return c.json(wire);
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.dag",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid },
      });
    }
  });

  // ── POST /:wfid/cancel — external cancel ─────────────────────────
  // No request body — `CancelWorkflowArgs` only carries `workflowId`.
  // The substrate's `cancelWorkflow` returns void; the route does a
  // second `getDag` so the response carries the post-cancel header.
  app.post("/:wfid/cancel", async (c) => {
    const wfid = c.req.param("wfid");
    try {
      await resolve(c).cancelWorkflow({ workflowId: wfid });
      const dag = await resolve(c).getDag(wfid);
      const iter = iterationCountForNodes(dag.nodes);
      logEvent(c, "workflow.cancel", { workflowId: wfid });
      return c.json(projectWorkflowHeader(dag.workflow, iter));
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.cancel",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid },
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Coord-callback mutation surface (M2.5). Eight routes that expose
  // every primitive on `WorkflowService` except `cancelWorkflow`
  // (which is the operator-only route above). Auth is substrate-
  // derived; handlers forward `workflowId` only.
  // ─────────────────────────────────────────────────────────────────

  // ── POST /:wfid/nodes — addNode ──────────────────────────────────
  app.post("/:wfid/nodes", async (c) => {
    const wfid = c.req.param("wfid");
    const parsed = await parseJsonBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const validated = validateAddNodeBody(parsed.body);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const body = validated.value;
    try {
      const result = await resolve(c).addNode({
        workflowId: wfid,
        kind: body.kind,
        spec: body.spec,
        parents: body.parents,
      });
      logEvent(c, "workflow.addNode", {
        workflowId: wfid,
        nodeId: result.nodeId,
        kind: body.kind,
      });
      return c.json(result);
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.addNode",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid },
      });
    }
  });

  // ── POST /:wfid/edges — addEdge ──────────────────────────────────
  app.post("/:wfid/edges", async (c) => {
    const wfid = c.req.param("wfid");
    const parsed = await parseJsonBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const validated = validateAddEdgeBody(parsed.body);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const body = validated.value;
    try {
      await resolve(c).addEdge({
        workflowId: wfid,
        fromNodeId: body.fromNodeId,
        toNodeId: body.toNodeId,
      });
      // The substrate returns `{ toPhase }`; the wire shape echoes the
      // (from, to) pair instead — useful for the caller who already has
      // the phase (it computed the edge itself) but wants confirmation
      // of the endpoints in the JSON response without re-fetching the
      // DAG.
      logEvent(c, "workflow.addEdge", {
        workflowId: wfid,
        fromNodeId: body.fromNodeId,
        toNodeId: body.toNodeId,
      });
      return c.json({ fromNodeId: body.fromNodeId, toNodeId: body.toNodeId });
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.addEdge",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid },
      });
    }
  });

  // ── POST /:wfid/subgraph — addSubgraph ───────────────────────────
  app.post("/:wfid/subgraph", async (c) => {
    const wfid = c.req.param("wfid");
    const parsed = await parseJsonBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const validated = validateAddSubgraphBody(parsed.body);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const body = validated.value;
    try {
      const result = await resolve(c).addSubgraph({
        workflowId: wfid,
        nodes: body.nodes.map((n) => ({
          tempId: n.tempId,
          kind: n.kind,
          spec: n.spec,
          ...(n.existingParents !== undefined ? { existingParents: n.existingParents } : {}),
        })),
        edges: body.edges.map((e) => ({
          from: nodeRefFromWire(e.from),
          to: nodeRefFromWire(e.to),
        })),
      });
      logEvent(c, "workflow.addSubgraph", {
        workflowId: wfid,
        insertedCount: result.insertedNodes.length,
      });
      return c.json({ insertedNodes: result.insertedNodes });
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.addSubgraph",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid },
      });
    }
  });

  // ── POST /:wfid/nodes/:nid/cancel — cancelNode ───────────────────
  app.post("/:wfid/nodes/:nid/cancel", async (c) => {
    const wfid = c.req.param("wfid");
    const nid = c.req.param("nid");
    try {
      await resolve(c).cancelNode({ workflowId: wfid, nodeId: nid });
      // Substrate's `cancelNode` returns void; project the post-cancel
      // node so the caller observes the new `status` / `endedAt`
      // without a second round-trip.
      const node = await resolve(c).getNode(nid);
      logEvent(c, "workflow.cancelNode", { workflowId: wfid, nodeId: nid });
      return c.json(projectWorkflowNode(node));
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.cancelNode",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid, nodeId: nid },
      });
    }
  });

  // ── POST /:wfid/finish — finishWorkflow ──────────────────────────
  app.post("/:wfid/finish", async (c) => {
    const wfid = c.req.param("wfid");
    const parsed = await parseJsonBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const validated = validateFinishWorkflowBody(parsed.body);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const body = validated.value;
    try {
      await resolve(c).finishWorkflow({ workflowId: wfid, outcome: body.outcome });
      const dag = await resolve(c).getDag(wfid);
      const iter = iterationCountForNodes(dag.nodes);
      logEvent(c, "workflow.finish", { workflowId: wfid, outcome: body.outcome });
      return c.json(projectWorkflowHeader(dag.workflow, iter));
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.finish",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid },
      });
    }
  });

  // ── DELETE /:wfid/nodes/:nid — removeNode ────────────────────────
  app.delete("/:wfid/nodes/:nid", async (c) => {
    const wfid = c.req.param("wfid");
    const nid = c.req.param("nid");
    try {
      await resolve(c).removeNode({ workflowId: wfid, nodeId: nid });
      logEvent(c, "workflow.removeNode", { workflowId: wfid, nodeId: nid });
      return c.body(null, 204);
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.removeNode",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid, nodeId: nid },
      });
    }
  });

  // ── DELETE /:wfid/edges/:from/:to — removeEdge ───────────────────
  app.delete("/:wfid/edges/:from/:to", async (c) => {
    const wfid = c.req.param("wfid");
    const from = c.req.param("from");
    const to = c.req.param("to");
    try {
      await resolve(c).removeEdge({
        workflowId: wfid,
        fromNodeId: from,
        toNodeId: to,
      });
      logEvent(c, "workflow.removeEdge", {
        workflowId: wfid,
        fromNodeId: from,
        toNodeId: to,
      });
      return c.body(null, 204);
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.removeEdge",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid, fromNodeId: from, toNodeId: to },
      });
    }
  });

  // ── PATCH /:wfid/nodes/:nid/spec — replaceNodeSpec ───────────────
  app.patch("/:wfid/nodes/:nid/spec", async (c) => {
    const wfid = c.req.param("wfid");
    const nid = c.req.param("nid");
    const parsed = await parseJsonBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const validated = validateReplaceNodeSpecBody(parsed.body);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const body = validated.value;
    try {
      await resolve(c).replaceNodeSpec({
        workflowId: wfid,
        nodeId: nid,
        newSpec: body.newSpec,
      });
      // Substrate returns void; project the post-update node so the
      // caller sees the normalized spec (the per-kind runner may have
      // dropped unknown keys or trimmed whitespace at validate time).
      const node = await resolve(c).getNode(nid);
      logEvent(c, "workflow.replaceNodeSpec", { workflowId: wfid, nodeId: nid });
      return c.json(projectWorkflowNode(node));
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.replaceNodeSpec",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid, nodeId: nid },
      });
    }
  });

  return app;
}

// Re-export the wire-shape type so `index.ts` doesn't have to thread
// it from `@emploke/contracts` separately. Matches the schedules
// route pattern.
export type { WorkflowStatusWire };
