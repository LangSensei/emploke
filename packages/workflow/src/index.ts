/**
 * Public API of `@emploke/workflow`.
 *
 * Substrate for an append-only DAG of workflow nodes (CEO O5):
 * `WorkflowService` exposes the 8 orchestrator-facing tools
 * (createWorkflow / createNode / addEdge / launchNode / markDone /
 * markFailed / cancelNode / finishWorkflow) plus read methods
 * (`get`, `getState`, `list`).
 *
 * Construction: `composeWorkflowModule({ dbFile, taskDispatcher })`.
 * Tests use `openTestWorkflowDb()` from `./testing`.
 *
 * Path helpers are exported because downstream packages (server,
 * future workflow CLI) need to compute the per-workflow / per-node
 * workdirs the same way the substrate does.
 */

export {
  composeWorkflowModule,
  type WorkflowModule,
  type WorkflowModuleOptions,
} from "./compose.js";
export {
  CorruptedWorkflowError,
  InvalidWorkflowIdError,
  InvalidWorkflowNodeIdError,
  InvalidWorkflowTransitionError,
  WorkflowCycleError,
  WorkflowError,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotReadyError,
  WorkflowNotFoundError,
} from "./errors.js";
export {
  WORKFLOW_NODES_SUBDIR,
  WORKFLOW_SUBDIR,
  workflowDir,
  workflowNodeDir,
  workflowRoot,
} from "./paths.js";
export type {
  CreateNodeArgs,
  CreateWorkflowArgs,
  NodeResultPatch,
  TaskDispatcher,
  TaskNodeSpec,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeStatus,
  WorkflowNodeType,
  WorkflowOutcome,
  WorkflowState,
  WorkflowStatus,
} from "./types.js";
export { WorkflowService } from "./workflow-service.js";
