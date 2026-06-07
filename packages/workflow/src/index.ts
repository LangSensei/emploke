/**
 * Public API of `@emploke/workflow`.
 *
 * An open substrate for a workflow DAG with mutation primitives. The
 * pkg owns three tables (`workflows` / `workflow_nodes` /
 * `workflow_edges`), the entity layer that round-trips them, the
 * error catalog, and the kind-handler interface that callers register
 * concrete kinds against at compose time.
 *
 * Construction goes through `composeWorkflowModule({ dbFile, … })`.
 * Tests use `openTestWorkflowDb()` from `./testing`.
 *
 * Per-kind wire DTOs (`WorkflowTaskNodeSpec`,
 * `WorkflowCoordinatorNodeSpec`, `WorkflowNodeWireSpec`, …) are owned
 * by and imported directly from `@emploke/contracts`; the substrate
 * stays kind-agnostic and takes no workspace dep on the wire pkg.
 */

// ─── Composition ────────────────────────────────────────────────────
export {
  composeWorkflowModule,
  type WorkflowModule,
  type WorkflowModuleOptions,
} from "./compose.js";
// ─── Errors ─────────────────────────────────────────────────────────
export {
  InvalidWorkflowIdError,
  InvalidWorkflowNodeIdError,
  MultipleSuccessorCoordsError,
  OrphanCoordInsertError,
  ParentlessTempError,
  ParentStateError,
  UnknownTempIdError,
  WorkflowAlreadyTerminalError,
  WorkflowEdgeAlreadyExistsError,
  WorkflowEdgeCycleError,
  WorkflowEdgeNotFoundError,
  WorkflowEnumValueError,
  WorkflowError,
  WorkflowKindRegistryFrozenError,
  WorkflowMutationUnauthorizedError,
  WorkflowNodeKindAlreadyRegisteredError,
  WorkflowNodeKindNotRegisteredError,
  WorkflowNodeKindShapeError,
  WorkflowNodeKindUnknownError,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotMutableError,
  WorkflowNodeSpecError,
  WorkflowNotFoundError,
  WouldOrphanChildError,
} from "./errors.js";
// ─── Path helpers ───────────────────────────────────────────────────
export {
  WORKFLOW_NODES_SUBDIR,
  WORKFLOW_SUBDIR,
  workflowDir,
  workflowNodeDir,
  workflowRoot,
} from "./paths.js";
// ─── Substrate types ────────────────────────────────────────────────
export type {
  WorkflowNodeKindHandler,
  WorkflowNodeSpecEnvelope,
  WorkflowNodeStatus,
  WorkflowNodeValidateCtx,
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
// ─── Repository (package-internal for tests) ────────────────────────
export { WorkflowRepository } from "./workflow-repository.js";
// ─── Service ────────────────────────────────────────────────────────
export {
  type AddEdgeArgs,
  type AddEdgeResult,
  type AddNodeArgs,
  type AddNodeResult,
  type CancelNodeArgs,
  type CancelWorkflowArgs,
  type CreateWorkflowArgs,
  type CreateWorkflowResult,
  type FinishWorkflowArgs,
  type WorkflowDagSnapshot,
  WorkflowService,
  type WorkflowServiceOpts,
} from "./workflow-service.js";
