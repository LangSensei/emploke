/**
 * Per-domain error policy for the workflows routes.
 *
 * Source of truth for the (class, status) pairs is the workflow
 * substrate's error catalog in `packages/workflow/src/errors.ts`.
 *
 * Status assignments:
 *
 *   - 400 — structural validation rejections the caller can fix.
 *   - 404 — addressing miss (workflow / node / edge not in this
 *           workspace).
 *   - 409 — CAS / FSM conflict (workflow already terminal, node not
 *           mutable at the requested verb, edge would close a cycle,
 *           remove would orphan a child, etc.). The substrate emits
 *           these AFTER the row exists — the caller observed a stale
 *           state.
 *   - 500 — operator-config or schema-corruption (kind unknown, enum
 *           value not in vocabulary, kind shape invalid). These
 *           cannot fire from caller-supplied input on a healthy
 *           deploy; the body collapses to "internal error" because
 *           the names are NOT on the SAFE_ERROR_NAMES allow-list.
 *
 * The catalog-resolution failures the worker-kind handler would throw
 * (`AgentNotFoundError` / `AgentResolutionFailedError` from the task
 * pkg) are NOT listed here: the M2 routes shipped in this iteration
 * (`list` / `create` / `get` / `dag` / `cancel`) never traverse the
 * worker-kind handler. When the M3 surface adds DAG-mutation routes,
 * those rows can be added at that time.
 */

import {
  AgentNotFoundError,
  AgentResolutionFailedError,
  CorruptedTaskError,
  EntryNotReadyError,
  InvalidTaskIdError,
  InvalidTransition,
  ManagerShuttingDownError,
  RuntimeDoesNotSupportTasksError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
} from "@emploke/task";
import {
  EmptyParentsError,
  InvalidWorkflowIdError,
  InvalidWorkflowNodeIdError,
  MultipleSuccessorCoordsError,
  OrphanCoordInsertError,
  ParentStateError,
  WorkflowAlreadyTerminalError,
  WorkflowEdgeCycleError,
  WorkflowEdgeNotFoundError,
  WorkflowEnumValueError,
  WorkflowError,
  WorkflowMutationUnauthorizedError,
  WorkflowNodeKindShapeError,
  WorkflowNodeKindUnknownError,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotMutableError,
  WorkflowNodeSpecError,
  WorkflowNotFoundError,
  WorkflowRemoveEdgeOrphansChildError,
  WorkflowRemoveNodeOrphansChildError,
  WorkflowSubgraphCyclicError,
  WorkflowSubgraphEmptyError,
  WorkflowSubgraphMultipleCoordTempsError,
  WorkflowSubgraphNodeRefUnresolvedError,
  WorkflowSubgraphTempIdInvalidError,
  WorkflowSubgraphTempParentlessError,
} from "@emploke/workflow";
import type { ErrorPolicy } from "../_respond-error.js";
import { opaqueAgentResolutionBody } from "./_shared-bodies.js";

export const workflowsErrorPolicy: ErrorPolicy = {
  name: "workflows",
  statuses: [
    // 404 — addressing miss
    [WorkflowNotFoundError, 404],
    [WorkflowNodeNotFoundError, 404],
    [WorkflowEdgeNotFoundError, 404],

    // 400 — caller-fixable structural validation
    [InvalidWorkflowIdError, 400],
    [InvalidWorkflowNodeIdError, 400],
    [WorkflowNodeSpecError, 400],
    [EmptyParentsError, 400],
    [WorkflowSubgraphEmptyError, 400],
    [WorkflowSubgraphTempIdInvalidError, 400],
    [WorkflowSubgraphTempParentlessError, 400],
    [WorkflowSubgraphNodeRefUnresolvedError, 400],

    // 409 — FSM / DAG conflict against existing state
    [WorkflowAlreadyTerminalError, 409],
    [WorkflowMutationUnauthorizedError, 409],
    [WorkflowNodeNotMutableError, 409],
    [WorkflowEdgeCycleError, 409],
    [MultipleSuccessorCoordsError, 409],
    [OrphanCoordInsertError, 409],
    [ParentStateError, 409],
    [WorkflowRemoveNodeOrphansChildError, 409],
    [WorkflowRemoveEdgeOrphansChildError, 409],
    [WorkflowSubgraphCyclicError, 409],
    [WorkflowSubgraphMultipleCoordTempsError, 409],

    // 500 — operator-config or schema-corruption. Bodies collapse to
    // "internal error" because the names are not on SAFE_ERROR_NAMES.
    [WorkflowNodeKindUnknownError, 500],
    [WorkflowEnumValueError, 500],
    [WorkflowNodeKindShapeError, 500],

    // Task-package surface — reachable from worker-kind handler
    // dispatch paths surfaced via future DAG-mutation routes. Listed
    // here proactively so policy is consistent with the schedules
    // policy's same fallthrough block.
    [InvalidTaskIdError, 400],
    [TaskNotFoundError, 404],
    [AgentNotFoundError, 400],
    [AgentResolutionFailedError, 500, opaqueAgentResolutionBody],
    [RuntimeDoesNotSupportTasksError, 400],
    [
      EntryNotReadyError,
      409,
      (err) => {
        const e = err as EntryNotReadyError;
        return {
          error: e.message,
          code: e.name,
          agent: e.agent,
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
        };
      },
    ],
    [InvalidTransition, 409],
    [ManagerShuttingDownError, 503],
    [TaskIdAllocationFailedError, 500],
    [CorruptedTaskError, 500],

    // `WorkflowError` is the abstract base — listed LAST so concrete
    // subclasses match first. Defaults to 400 (most workflow-base
    // throws are caller validation flavors).
    [WorkflowError, 400],
  ],
};
