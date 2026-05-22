/**
 * Public API of `@emploke/workflows`.
 *
 * Substrate for an append-only DAG of workflow nodes (CEO O5):
 * `WorkflowsService` exposes the 8 orchestrator-facing tools
 * (createWorkflow / createNode / addEdge / launchNode / markDone /
 * markFailed / cancelNode / finishWorkflow) plus read methods
 * (`get`, `getState`, `list`).
 *
 * Construction: `composeWorkflowsModule({ dbFile, taskDispatcher })`.
 * Tests use `openTestWorkflowsDb()` from `./testing`.
 *
 * Path helpers are exported because downstream packages (server,
 * future workflow CLI) need to compute the per-workflow / per-node
 * workdirs the same way the substrate does.
 */

export {
  composeWorkflowsModule,
  type WorkflowsModule,
  type WorkflowsModuleOptions,
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
  WORKFLOWS_SUBDIR,
  workflowDir,
  workflowNodeDir,
  workflowsRoot,
} from "./paths.js";
export { WorkflowsService } from "./service.js";
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
