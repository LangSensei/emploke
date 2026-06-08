/**
 * Routes for `/api/workspaces/:id/workflows`. Workspace-scoped read
 * + lifecycle + coord-callback mutation surface over `WorkflowService`,
 * plus dashboard-facing artifact list / static-bytes routes that
 * bridge the substrate's on-disk artifact dirs to the browser.
 *
 * The substrate is kind-agnostic and stores nodes opaquely as
 * `{ kind, spec: unknown }`; the wire-layer projection
 * (`_workflow-projection.ts`) flattens the per-kind shapes for the
 * dashboard / CLI and enriches each node with its dispatched
 * `taskId` via the task service reverse-lookup (Mode B drill-down).
 *
 * Resolver-injection pattern matches `routes/schedules.ts` /
 * `routes/tasks.ts`: the mount point in `server/src/index.ts` hands
 * in three functions that pull the workspace-scoped services and the
 * workspace fs root out of Hono's per-request context. The route
 * file never touches workspace resolution, only the workflow + tasks
 * surfaces and the resolved `workspaceDir`.
 *
 * ## Endpoints
 *
 *   - `GET    /`                          — list workflows; `?status=` narrows
 *   - `POST   /`                          — seed a workflow + its initial coord
 *   - `GET    /:wfid`                     — header only (with `iterationCount`)
 *   - `GET    /:wfid/dag`                 — full snapshot (header + nodes + edges) with taskId enrichment
 *   - `POST   /:wfid/cancel`              — external cancel; returns updated header
 *   - `GET    /:wfid/artifacts`           — list workflow-summary + per-node artifacts
 *   - `GET    /:wfid/artifacts/:encoded`  — static bytes for one artifact
 *   - `POST   /:wfid/nodes`               — add a single node (M2.5)
 *   - `POST   /:wfid/edges`               — add a single edge (M2.5)
 *   - `POST   /:wfid/subgraph`            — batch insert N nodes + M edges (M2.5)
 *   - `POST   /:wfid/nodes/:nid/cancel`   — cancel a worker-kind node (M2.5)
 *   - `POST   /:wfid/finish`              — flip workflow terminal (M2.5)
 *   - `DELETE /:wfid/nodes/:nid`          — delete a not_started node (M2.5)
 *   - `DELETE /:wfid/edges/:from/:to`     — delete a not_started edge (M2.5)
 *   - `PATCH  /:wfid/nodes/:nid/spec`     — re-validate + replace spec (M2.5)
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
 *
 * ## Artifact route encoding
 *
 * `GET /:wfid/artifacts/:encodedPath` reads a single Hono path
 * segment, so multi-segment paths (`summary/foo/bar.md`) MUST be
 * url-encoded with `%2F` for `/`. Two sentinels:
 *   - `summary/<rest>` — `<workflowDir>/artifact/<rest>` (no-store)
 *   - `nodes/<nodeId>/<rest>` — `<tasksRoot>/<taskId>/artifact/<rest>`
 *     (`Cache-Control: max-age=300` once the owning task is terminal,
 *     `no-store` while it is still running so the dashboard reloads
 *     mid-stream files cleanly).
 * Any other prefix yields 400.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AddEdgeBody,
  AddNodeBody,
  AddSubgraphBody,
  AddSubgraphEdgeInputWire,
  AddSubgraphNodeInputWire,
  CancelWorkflowBody,
  CreateWorkflowBody,
  FinishWorkflowBody,
  NodeRefWire,
  ReplaceNodeSpecBody,
  WorkflowArtifactsResponse,
  WorkflowArtifactWire,
  WorkflowDagWire,
  WorkflowHeaderWire,
  WorkflowStatusWire,
} from "@emploke/api";
import {
  tasksRoot as resolveTasksRoot,
  safeJoinUnderRoot as safeJoinTaskRoot,
  TASK_ARTIFACT_SUBDIR,
  type TaskService,
} from "@emploke/task";
import {
  type NodeKind,
  type NodeRef,
  workflowDir as resolveWorkflowDir,
  WorkflowError,
  type WorkflowService,
} from "@emploke/workflow";
import { Hono } from "hono";
import { mimeBucketFor } from "../util/mime-bucket.js";
import { workflowsErrorPolicy } from "./_error-policies/workflows.js";
import { respondError } from "./_respond-error.js";
import { errorBody, logEvent, parseJsonBody } from "./_shared.js";
import {
  iterationCountForNodes,
  projectWorkflowDag,
  projectWorkflowHeader,
  projectWorkflowNodeWithTaskId,
} from "./_workflow-projection.js";

export type WorkflowServiceResolver = (c: import("hono").Context) => WorkflowService;
export type WorkflowTasksResolver = (c: import("hono").Context) => TaskService;
export type WorkflowWorkspaceDirResolver = (c: import("hono").Context) => string;

const ALLOWED_CREATE_KEYS = new Set(["brief", "details", "coordinatorAgent", "metadata"]);
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

function validateCreatedSinceQuery(raw: string | undefined): ValidationResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  // Accept any ISO 8601 string that `Date.parse` understands. The
  // substrate forwards the string verbatim into a SQL `>=` predicate
  // against the text-sortable `created_at` column, so any parseable
  // shape works — we only reject obviously malformed input so the
  // caller learns about it at the boundary rather than getting an
  // empty list back.
  if (Number.isNaN(Date.parse(raw))) {
    return { ok: false, error: "createdSince must be an ISO 8601 timestamp" };
  }
  return { ok: true, value: raw };
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
  if (outcome === "succeeded") {
    const allowed = new Set(["outcome", "success"]);
    for (const k of Object.keys(raw)) {
      if (!allowed.has(k)) return { ok: false, error: `request body has unknown key "${k}"` };
    }
    const { success } = raw;
    if (success !== undefined) {
      if (!isPlainObject(success)) {
        return { ok: false, error: "success must be an object" };
      }
      for (const k of Object.keys(success)) {
        if (k !== "output") {
          return { ok: false, error: `success has unknown key "${k}"` };
        }
      }
      const out = (success as { output?: unknown }).output;
      if (out !== undefined && out !== null && typeof out !== "string") {
        return { ok: false, error: "success.output must be a string or null" };
      }
      return {
        ok: true,
        value: {
          outcome: "succeeded",
          success: { output: out === undefined ? null : (out as string | null) },
        },
      };
    }
    return { ok: true, value: { outcome: "succeeded" } };
  }
  // outcome === "failed"
  const allowed = new Set(["outcome", "failure"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) return { ok: false, error: `request body has unknown key "${k}"` };
  }
  const { failure } = raw;
  if (!isPlainObject(failure)) {
    return { ok: false, error: "failure is required and must be an object" };
  }
  for (const k of Object.keys(failure)) {
    if (k !== "kind" && k !== "message") {
      return { ok: false, error: `failure has unknown key "${k}"` };
    }
  }
  const kind = (failure as { kind?: unknown }).kind;
  if (kind !== undefined && kind !== "coord") {
    return { ok: false, error: 'failure.kind must be "coord" when supplied' };
  }
  const message = (failure as { message?: unknown }).message;
  if (typeof message !== "string") {
    return { ok: false, error: "failure.message must be a string" };
  }
  return {
    ok: true,
    value: {
      outcome: "failed",
      failure: { kind: "coord", message },
    },
  };
}

/**
 * Internal narrowed body shape used by the cancel-route handler.
 * Mirrors {@link CancelWorkflowBody} but with `kind` widened from
 * optional `"user"?` to required `"user"`, reflecting the
 * normalization the validator performs (omitted -> "user"). Keeping
 * the wire contract optional is correct (callers can elide it) but
 * narrowing the post-validation value lets downstream code drop the
 * stale `?? "user"` defense at the call site.
 */
interface ValidatedCancelWorkflowBody {
  readonly cancellation: {
    readonly kind: "user";
    readonly message: string;
  };
}

function validateCancelWorkflowBody(raw: unknown): ValidationResult<ValidatedCancelWorkflowBody> {
  if (!isPlainObject(raw)) return { ok: false, error: "request body must be an object" };
  // Pre-v2.2 callers used `{ reason }` — reject explicitly so the
  // boundary failure is loud rather than silently dropped.
  if ("reason" in raw) {
    return {
      ok: false,
      error:
        'the pre-v2.2 "reason" body shape is no longer accepted; use { cancellation: { message } }',
    };
  }
  for (const k of Object.keys(raw)) {
    if (k !== "cancellation") {
      return { ok: false, error: `request body has unknown key "${k}"` };
    }
  }
  const { cancellation } = raw;
  if (!isPlainObject(cancellation)) {
    return { ok: false, error: "cancellation is required and must be an object" };
  }
  for (const k of Object.keys(cancellation)) {
    if (k !== "kind" && k !== "message") {
      return { ok: false, error: `cancellation has unknown key "${k}"` };
    }
  }
  const kind = (cancellation as { kind?: unknown }).kind;
  if (kind !== undefined && kind !== "user") {
    return { ok: false, error: 'cancellation.kind must be "user" when supplied' };
  }
  const message = (cancellation as { message?: unknown }).message;
  if (typeof message !== "string") {
    return { ok: false, error: "cancellation.message must be a string" };
  }
  return {
    ok: true,
    value: { cancellation: { kind: "user", message } },
  };
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

export function workflowsRoutes(
  resolve: WorkflowServiceResolver,
  resolveTasks: WorkflowTasksResolver,
  resolveWorkspaceDir: WorkflowWorkspaceDirResolver,
): Hono {
  const app = new Hono();

  // ── GET / — list with optional q / coordinatorAgent / createdSince ─
  app.get("/", async (c) => {
    const createdSinceResult = validateCreatedSinceQuery(c.req.query("createdSince"));
    if (!createdSinceResult.ok) {
      return c.json(errorBody(new WorkflowError(createdSinceResult.error)), 400);
    }
    const q = c.req.query("q");
    const coordinatorAgent = c.req.query("coordinatorAgent");
    const opts: {
      coordinatorAgent?: string;
      createdSince?: string;
      idLike?: string;
    } = {};
    if (q !== undefined && q !== "") opts.idLike = q;
    if (coordinatorAgent !== undefined && coordinatorAgent !== "") {
      opts.coordinatorAgent = coordinatorAgent;
    }
    if (createdSinceResult.value !== undefined) opts.createdSince = createdSinceResult.value;
    try {
      const list = await resolve(c).list(Object.keys(opts).length === 0 ? undefined : opts);
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

  // ── GET /:wfid/dag — full snapshot (with taskId enrichment) ──────
  app.get("/:wfid/dag", async (c) => {
    const wfid = c.req.param("wfid");
    try {
      const snapshot = await resolve(c).getDag(wfid);
      const wire: WorkflowDagWire = await projectWorkflowDag(snapshot, {
        tasks: resolveTasks(c),
      });
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
  // Body shape: `{ cancellation: { kind?: 'user', message } }`.
  // The substrate's `cancelWorkflow` returns void; the route does a
  // second `getDag` so the response carries the post-cancel header.
  app.post("/:wfid/cancel", async (c) => {
    const wfid = c.req.param("wfid");
    const parsed = await parseJsonBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const validated = validateCancelWorkflowBody(parsed.body);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const { cancellation } = validated.value;
    try {
      await resolve(c).cancelWorkflow({
        workflowId: wfid,
        cancellation: { kind: cancellation.kind, message: cancellation.message },
      });
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

  // ── GET /:wfid/artifacts — list workflow + per-node artifacts ────
  //
  // Aggregates two on-disk namespaces:
  //   1. `<workflowDir>/artifact/` — files the coordinator curated as
  //      workflow-summary artifacts. May not exist (returns []).
  //   2. `<tasksRoot>/<taskId>/artifact/` — per-node task artifacts.
  //      Resolved via the substrate enrichment (taskId reverse-lookup).
  //
  // Workflow-summary entries come first; node groups follow, sorted
  // by `nodeId` for stability across polls. A workflow with no
  // artifacts in either namespace returns `{ artifacts: [] }` (200);
  // a missing workflow returns 404.
  app.get("/:wfid/artifacts", async (c) => {
    const wfid = c.req.param("wfid");
    let snapshot: Awaited<ReturnType<WorkflowService["getDag"]>>;
    try {
      snapshot = await resolve(c).getDag(wfid);
    } catch (err) {
      return respondError(c, err, {
        route: "workflows.artifacts.list",
        policy: workflowsErrorPolicy,
        meta: { workflowId: wfid },
      });
    }

    const workspaceDir = resolveWorkspaceDir(c);
    const tasksSvc = resolveTasks(c);

    const summaryRoot = path.join(resolveWorkflowDir(workspaceDir, wfid), "artifact");
    const summaryFiles = await listFilesRecursive(summaryRoot);
    const summaryEntries: WorkflowArtifactWire[] = summaryFiles.map((f) => ({
      kind: "workflow-summary" as const,
      path: f.relPath,
      size: f.size,
      modifiedAt: f.modifiedAt,
      mimeBucket: mimeBucketFor(f.relPath),
    }));

    // Node groups: every node (worker AND coord) that resolves to a
    // dispatched task. We surface coord tasks too — the dashboard's
    // Mode B drill-down navigates to either kind uniformly.
    const nodes = [...snapshot.nodes].sort((a, b) => a.id.localeCompare(b.id));
    const tasksRoot = resolveTasksRoot(workspaceDir);
    const nodeEntries: WorkflowArtifactWire[] = [];
    for (const node of nodes) {
      const task = await tasksSvc.findTaskByWorkflowNode(node.id);
      if (task === null) continue;
      let taskDir: string;
      try {
        taskDir = safeJoinTaskRoot(tasksRoot, task.id);
      } catch {
        continue;
      }
      const artifactRoot = path.join(taskDir, TASK_ARTIFACT_SUBDIR);
      const files = await listFilesRecursive(artifactRoot);
      for (const f of files) {
        nodeEntries.push({
          kind: "node" as const,
          nodeId: node.id,
          taskId: task.id,
          path: f.relPath,
          size: f.size,
          modifiedAt: f.modifiedAt,
          mimeBucket: mimeBucketFor(f.relPath),
        });
      }
    }

    const response: WorkflowArtifactsResponse = {
      artifacts: [...summaryEntries, ...nodeEntries],
    };
    return c.json(response);
  });

  // ── GET /:wfid/artifacts/:encodedPath — stream one artifact ──────
  //
  // `encodedPath` is a SINGLE Hono path segment, so multi-segment
  // paths like `summary/foo/bar.md` need to be encoded with `%2F`
  // for `/` on the wire. The route decodes once, branches on
  // sentinel prefix, then path-traverses-checks via
  // `safeJoinNested` before serving bytes.
  //
  //   - `summary/<rest>` → `<workflowDir>/artifact/<rest>` (no-store)
  //   - `nodes/<nodeId>/<rest>` → `<tasksRoot>/<taskId>/artifact/<rest>`
  //     (`max-age=300` once owning task is terminal; `no-store` while
  //     it is still running, since the worker may still be appending)
  //
  // Any other prefix yields 400.
  app.get("/:wfid/artifacts/:encodedPath", async (c) => {
    const wfid = c.req.param("wfid");
    const encoded = c.req.param("encodedPath");

    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      return c.json({ error: "encodedPath is not a valid percent-encoded string" }, 400);
    }

    // Cheap up-front traversal rejection. The per-segment
    // `safeJoinNested` below is still the canonical defence, but
    // failing the obvious cases here keeps the error body
    // descriptive ("traversal in path" vs the generic "escapes root").
    if (decoded.includes("..") || decoded.includes("\0")) {
      return c.json({ error: "traversal segment in artifact path" }, 400);
    }

    const workspaceDir = resolveWorkspaceDir(c);
    let absPath: string;
    let cacheControl: string;

    if (decoded.startsWith("summary/")) {
      const rest = decoded.slice("summary/".length);
      if (rest === "" || rest.startsWith("/")) {
        return c.json({ error: "summary path missing trailing segments" }, 400);
      }
      try {
        const summaryRoot = path.join(resolveWorkflowDir(workspaceDir, wfid), "artifact");
        absPath = safeJoinNested(summaryRoot, rest);
      } catch {
        return c.json({ error: "artifact path escapes workflow root" }, 400);
      }
      cacheControl = "no-store";
    } else if (decoded.startsWith("nodes/")) {
      // `nodes/<nodeId>/<rest>` — minimum two slashes inside.
      const tail = decoded.slice("nodes/".length);
      const sep = tail.indexOf("/");
      if (sep <= 0 || sep === tail.length - 1) {
        return c.json({ error: "nodes path must be nodes/<nodeId>/<rest>" }, 400);
      }
      const nodeId = tail.slice(0, sep);
      const rest = tail.slice(sep + 1);
      const task = await resolveTasks(c).findTaskByWorkflowNode(nodeId);
      if (task === null) {
        return c.json({ error: "no task dispatched for node" }, 404);
      }
      try {
        const tasksRoot = resolveTasksRoot(workspaceDir);
        const taskDir = safeJoinTaskRoot(tasksRoot, task.id);
        const artifactRoot = path.join(taskDir, TASK_ARTIFACT_SUBDIR);
        absPath = safeJoinNested(artifactRoot, rest);
      } catch {
        return c.json({ error: "artifact path escapes task root" }, 400);
      }
      // Per-node artifact bytes are only write-once AFTER the owning
      // task reaches a terminal status (the worker may still be
      // appending to a file while it runs). Cache aggressively once
      // terminal; force a re-fetch on every read while running.
      const taskTerminal =
        task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";
      cacheControl = taskTerminal ? "max-age=300" : "no-store";
    } else {
      return c.json({ error: "artifact path must start with summary/ or nodes/<nid>/" }, 400);
    }

    try {
      const st = await stat(absPath);
      if (!st.isFile()) {
        return c.json({ error: "artifact not found" }, 404);
      }
    } catch {
      return c.json({ error: "artifact not found" }, 404);
    }

    const basename = path.basename(absPath);
    const contentType = contentTypeFor(basename);
    const node = createReadStream(absPath);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        node.on("data", (chunk) => {
          const buf =
            typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
          controller.enqueue(buf);
        });
        node.on("end", () => controller.close());
        node.on("error", (err) => controller.error(err));
      },
      cancel() {
        node.destroy();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${encodeURIComponent(basename)}"`,
        "Cache-Control": cacheControl,
      },
    });
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
      // without a second round-trip. Enrich with `taskId` for parity
      // with the `/dag` projection.
      const node = await resolve(c).getNode(nid);
      const wire = await projectWorkflowNodeWithTaskId(node, { tasks: resolveTasks(c) });
      logEvent(c, "workflow.cancelNode", { workflowId: wfid, nodeId: nid });
      return c.json(wire);
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
      if (body.outcome === "succeeded") {
        await resolve(c).finishWorkflow({
          workflowId: wfid,
          outcome: "succeeded",
          success: { output: body.success?.output ?? null },
        });
      } else {
        await resolve(c).finishWorkflow({
          workflowId: wfid,
          outcome: "failed",
          failure: { kind: "coord", message: body.failure.message },
        });
      }
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
      // Enrich with `taskId` for parity with the `/dag` projection.
      const node = await resolve(c).getNode(nid);
      const wire = await projectWorkflowNodeWithTaskId(node, { tasks: resolveTasks(c) });
      logEvent(c, "workflow.replaceNodeSpec", { workflowId: wfid, nodeId: nid });
      return c.json(wire);
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

/**
 * Recursive directory walk. Returns one entry per regular file
 * under `root` with the path relative to `root` (forward slashes,
 * cross-platform), size, and ISO mtime. Returns `[]` when `root`
 * doesn't exist or is unreadable — the caller treats "no curated
 * artifacts yet" as the steady-state for a fresh workflow rather
 * than a 500.
 *
 * Per-file errors are warn-skipped: a transient `stat` fault on one
 * entry doesn't poison the whole listing. (Mirrors the
 * warn-and-skip pattern in `TaskRepository.list`.)
 */
async function listFilesRecursive(root: string): Promise<readonly FileEntry[]> {
  const out: FileEntry[] = [];
  await walk(root, "");
  return out;

  async function walk(dir: string, rel: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Missing or unreadable. For the root dir this is the
      // "no artifacts yet" case; for a nested dir we just skip.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, childRel);
      } else if (entry.isFile()) {
        try {
          const st = await stat(full);
          out.push({
            relPath: childRel,
            size: st.size,
            modifiedAt: st.mtime.toISOString(),
          });
        } catch {
          // Best-effort: skip files that disappear between readdir
          // and stat.
        }
      }
    }
  }
}

interface FileEntry {
  readonly relPath: string;
  readonly size: number;
  readonly modifiedAt: string;
}

/**
 * Safely join a multi-segment relative path under a root, rejecting
 * any segment that would escape. Mirrors the per-id
 * `safeJoinUnderRoot` from the task/workflow path helpers but takes
 * a `/`-delimited multi-segment rel path (the artifact subpath).
 */
function safeJoinNested(root: string, rel: string): string {
  if (rel === "" || rel.includes("\0")) {
    throw new Error("invalid artifact rel path");
  }
  const segs = rel.split(/[\\/]/);
  for (const s of segs) {
    if (s === "" || s === "." || s === ".." || s.includes("\0")) {
      throw new Error("invalid artifact rel segment");
    }
  }
  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, ...segs);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  if (!candidate.startsWith(rootWithSep) && candidate !== normalizedRoot) {
    throw new Error("artifact path escapes root");
  }
  return candidate;
}

/**
 * Ext-to-MIME table for the artifact static-bytes route. Lifted
 * verbatim from `routes/tasks.ts` so the two artifact-serving
 * routes stay consistent. Unknown extensions fall through to
 * `application/octet-stream` (browser treats as download).
 */
function contentTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "txt":
    case "log":
      return "text/plain; charset=utf-8";
    case "md":
      return "text/markdown; charset=utf-8";
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "csv":
      return "text/csv; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
