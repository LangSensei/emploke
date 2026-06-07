/**
 * Public API of `@emploke/workflow`.
 *
 * A closed-kind substrate for a workflow DAG with mutation primitives.
 * The pkg owns three tables (`workflows` / `workflow_nodes` /
 * `workflow_edges`), the entity layer that round-trips them, the
 * error catalog, and the `WorkflowNodeRunner` interface that callers
 * implement once per `NodeKind` and inject at compose time via the
 * `runners: WorkflowRunners` field on {@link composeWorkflowModule}.
 *
 * Construction goes through `composeWorkflowModule({ dbFile, …,
 * runners })`. Tests use `openTestWorkflowDb()` from `./testing`.
 *
 * Per-kind wire DTOs (`WorkflowWorkerNodeSpec`,
 * `WorkflowCoordinatorNodeSpec`, `WorkflowNodeWireSpec`, …) are owned
 * by and imported directly from `@emploke/contracts`; the substrate
 * stays kind-agnostic and takes no workspace dep on the wire pkg.
 */

// ─── Substrate types ────────────────────────────────────────────────
export type { NodeRef } from "./_dag.js";
// ─── Composition ────────────────────────────────────────────────────
export {
  composeWorkflowModule,
  type WorkflowModule,
  type WorkflowModuleOptions,
} from "./compose.js";
// ─── Errors ─────────────────────────────────────────────────────────
export {
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
} from "./errors.js";
// ─── Path helpers ───────────────────────────────────────────────────
export {
  WORKFLOW_NODES_SUBDIR,
  WORKFLOW_SUBDIR,
  workflowDir,
  workflowNodeDir,
  workflowRoot,
} from "./paths.js";
export type {
  NodeKind,
  WorkflowNodeRunner,
  WorkflowNodeSpecEnvelope,
  WorkflowNodeStatus,
  WorkflowNodeValidateCtx,
  WorkflowRunners,
  WorkflowStatus,
} from "./types.js";
export { deriveIterationCount, hasLiveCoord } from "./types.js";
// ─── Validators ─────────────────────────────────────────────────────
export {
  assertValidWorkflowId,
  assertValidWorkflowNodeId,
  assertValidWorkflowNodeKind,
  assertValidWorkflowNodeStatusEnum,
  assertValidWorkflowStatusEnum,
  generateWorkflowId,
  generateWorkflowNodeId,
} from "./validate.js";
// ─── Entity classes ─────────────────────────────────────────────────
export {
  WorkflowEdgeEntity,
  WorkflowEntity,
  WorkflowNodeEntity,
} from "./workflow-entity.js";
// ─── Service ────────────────────────────────────────────────────────
export {
  type AddEdgeArgs,
  type AddEdgeResult,
  type AddNodeArgs,
  type AddNodeResult,
  type AddSubgraphArgs,
  type AddSubgraphEdgeInput,
  type AddSubgraphInsertedNode,
  type AddSubgraphNodeInput,
  type AddSubgraphResult,
  type CancelNodeArgs,
  type CancelWorkflowArgs,
  type CreateWorkflowArgs,
  type CreateWorkflowResult,
  type FinishWorkflowArgs,
  type RemoveEdgeArgs,
  type RemoveNodeArgs,
  type ReplaceNodeSpecArgs,
  type WorkflowDagSnapshot,
  WorkflowService,
  type WorkflowServiceOpts,
} from "./workflow-service.js";
