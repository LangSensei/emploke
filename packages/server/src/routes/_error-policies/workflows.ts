/**
 * Per-domain error policy for the workflows routes.
 *
 * Source of truth for the (class, status) pairs is the workflow
 * substrate's error catalog in `packages/workflow/src/errors.ts`.
 *
 * Status assignments:
 *
 *   - 400 — caller-fixable structural validation. Note: the
 *           defensive enum / kind guards
 *           (`WorkflowNodeKindCorruptionError`,
 *           `WorkflowEnumValueCorruptionError`) are deliberately
 *           NOT listed here: they signal that a persisted row or
 *           internal lookup carried a value outside the closed enum,
 *           which is schema corruption and maps to 500. The
 *           caller-input shape guard for kind
 *           (`WorkflowNodeKindShapeError`) is the legitimate 400
 *           bucket for kind validation.
 *   - 403 — caller is not an authorised mutator (the substrate's auth
 *           gate: must be the unique running coordinator in this
 *           workflow). Distinct from 404 (entity missing) and 409
 *           (FSM/state conflict) — the entity exists, the request is
 *           well-formed, but the caller does not own this workflow.
 *   - 404 — addressing miss (workflow / node / edge not in this
 *           workspace).
 *   - 409 — CAS / FSM / DAG conflict against existing state (workflow
 *           already terminal, node not mutable at the requested verb,
 *           edge would close a cycle, remove would orphan a child,
 *           etc.). The substrate emits these AFTER the row exists —
 *           the caller observed a stale state.
 *
 * Agent-resolution failures from the coord-kind runner's `validate`
 * (`AgentNotFoundError` / `AgentResolutionFailedError` from the task
 * pkg) are listed below — reachable via `POST /workflows` at create
 * time AND via the M2.5 mutation routes (`addNode`, `addSubgraph`,
 * `replaceNodeSpec`) when the runner re-validates an agent FQN.
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
  WorkflowEnumValueCorruptionError,
  WorkflowError,
  WorkflowNodeKindCorruptionError,
  WorkflowNodeKindShapeError,
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
    // The shape guard for `kind` fires on caller input — `kind` must
    // be a non-empty string before the substrate even tries to map
    // it to a runner. Honest 400.
    [WorkflowNodeKindShapeError, 400],

    // 500 — defensive guards that fire only when a persisted row or
    // internal lookup carries a value outside the closed enum. These
    // signal schema corruption / older-binary-leftover rows, NOT
    // caller mistakes; the response body is an opaque sanitized
    // string at the respond-error layer (see SAFE_ERROR_NAMES).
    [WorkflowNodeKindCorruptionError, 500],
    [WorkflowEnumValueCorruptionError, 500],

    // 409 — FSM / DAG conflict against existing state
    [WorkflowAlreadyTerminalError, 409],
    [WorkflowNodeNotMutableError, 409],
    [WorkflowEdgeCycleError, 409],
    [MultipleSuccessorCoordsError, 409],
    [OrphanCoordInsertError, 409],
    [ParentStateError, 409],
    [WorkflowRemoveNodeOrphansChildError, 409],
    [WorkflowRemoveEdgeOrphansChildError, 409],
    [WorkflowSubgraphCyclicError, 409],
    [WorkflowSubgraphMultipleCoordTempsError, 409],

    // Task-package surface — reachable from worker-kind handler
    // dispatch paths surfaced via M2.5 DAG-mutation routes. Listed
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
