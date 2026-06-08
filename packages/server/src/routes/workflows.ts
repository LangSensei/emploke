/**
 * Routes for `/api/workspaces/:id/workflows`. Workspace-scoped read
 * + lifecycle surface over `WorkflowService`. The substrate is
 * kind-agnostic and stores nodes opaquely as
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
 *   - `GET    /`                — list workflows; `?status=` narrows
 *   - `POST   /`                — seed a workflow + its initial coord
 *   - `GET    /:wfid`           — header only (with `iterationCount`)
 *   - `GET    /:wfid/dag`       — full snapshot (header + nodes + edges)
 *   - `POST   /:wfid/cancel`    — external cancel; returns updated header
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
  CreateWorkflowBody,
  WorkflowDagWire,
  WorkflowHeaderWire,
  WorkflowStatusWire,
} from "@emploke/api";
import { WorkflowError, type WorkflowService, type WorkflowStatus } from "@emploke/workflow";
import { Hono } from "hono";
import { workflowsErrorPolicy } from "./_error-policies/workflows.js";
import { respondError } from "./_respond-error.js";
import { errorBody, logEvent, parseJsonBody } from "./_shared.js";
import {
  iterationCountForNodes,
  projectWorkflowDag,
  projectWorkflowHeader,
} from "./_workflow-projection.js";

export type WorkflowServiceResolver = (c: import("hono").Context) => WorkflowService;

const ALLOWED_CREATE_KEYS = new Set(["brief", "details", "coordinatorAgent", "metadata"]);
const KNOWN_STATUSES: readonly WorkflowStatus[] = ["running", "succeeded", "failed", "cancelled"];

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

  return app;
}

// Re-export the wire-shape type so `index.ts` doesn't have to thread
// it from `@emploke/contracts` separately. Matches the schedules
// route pattern.
export type { WorkflowStatusWire };
