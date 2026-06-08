/**
 * @emploke/api — T2 Application layer (orchestration).
 *
 * Composes T0/T1 (`workspace`, `catalog`, `session`, `task`, `runtime`,
 * `schedule`) into a per-workspace runtime context via
 * `composeApplication`. The HTTP transport (`@emploke/server`) calls
 * this; UI surfaces (`@emploke/dashboard`, `@emploke/cli`) speak HTTP
 * and don't see this layer at all.
 *
 * Wire contracts (route catalog, request / response body types, leaf
 * path helpers) live in the sibling `@emploke/contracts` pkg. This
 * barrel re-exports them so `@emploke/server` has a single import
 * site for both orchestration and contracts — `@emploke/dashboard`
 * and `@emploke/cli` should depend on `@emploke/contracts`
 * directly, which keeps orchestration out of their dep graph
 * structurally (not just by convention).
 *
 * See `docs/architecture.md § Tier model` for the full layering
 * rationale.
 */

// Re-export every wire contract from the sibling pkg so server can
// `import { ... } from "@emploke/api"` and get both layers in one shot.
export * from "@emploke/contracts";
// Orchestration (composeApplication + per-workspace WorkspaceContext)
export {
  type Application,
  type ApplicationOptions,
  composeApplication,
} from "./application.js";
export { makeTaskKindHandler, TaskScheduleTargetError } from "./wiring/schedule-task-handler.js";
export {
  type CoordNodeSpec,
  DEFAULT_COORD_MAX_POLL_ERRORS,
  DEFAULT_COORD_POLL_INTERVAL_MS,
  type MakeCoordNodeRunnerDeps,
  makeCoordNodeRunner,
  WorkflowCoordSpecError,
} from "./wiring/workflow-coord-task-runner.js";
export {
  DEFAULT_WORKER_MAX_POLL_ERRORS,
  DEFAULT_WORKER_POLL_INTERVAL_MS,
  type MakeWorkerNodeRunnerDeps,
  makeWorkerNodeRunner,
  type WorkerNodeSpec,
  WorkflowWorkerSpecError,
} from "./wiring/workflow-task-runner.js";
export { type WorkspaceContext, WorkspaceHasLiveTasksError } from "./workspace-context.js";
