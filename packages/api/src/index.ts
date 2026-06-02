/**
 * @emploke/api — T2 Application layer.
 *
 * Public surface of emploke: both the cross-pkg wire contracts and the
 * orchestration that composes T0/T1 (`workspace`, `catalog`, `session`,
 * `task`, `runtime`, `schedule`) into a per-workspace runtime context.
 *
 * The internal split is preserved purely for code organisation:
 *  - `./contracts/*` — types that cross the public boundary (HTTP routes,
 *    out-of-band IPC files, `EMPLOKE_HOME` resolution); tree-shake-friendly
 *    leaves so dashboard / cli can pull wire types without dragging in
 *    orchestration code paths.
 *  - `./application.ts`, `./workspace-context.ts`, `./wiring/*` — live
 *    composition; the `composeApplication` entry point assembles a
 *    process-wide registry and lazily mints per-workspace contexts.
 *
 * Pairs with `@emploke/server` (HTTP transport over these capabilities)
 * and the UI surfaces (`@emploke/terminal`, `@emploke/dashboard`,
 * `@emploke/cli`).
 *
 * See `docs/architecture.md § Tier model` for the full layering rationale.
 */

// Orchestration (composeApplication + per-workspace WorkspaceContext)
export {
  type Application,
  type ApplicationOptions,
  composeApplication,
  type SpawnFn,
  type SpawnSessionResult,
} from "./application.js";
// Contracts (wire shapes that cross the public boundary)
export {
  DEFAULT_EMPLOKE_HOME,
  LOGS_SUBDIR,
  logsDir,
  RUNTIME_FILE_NAME,
  type RuntimeFile,
  resolveEmplokeHome,
  runtimeFilePath,
} from "./contracts/emploke-home.js";
export type { HealthResponse } from "./contracts/health.js";
export type {
  AgentManifestNode,
  McpManifestNode,
  OrphanManifestEntry,
  ResolveManifest,
  ResolveManifestNode,
  SkillManifestNode,
} from "./contracts/plan-to-manifest.js";
export {
  type AgentWithContent,
  type AnchorResponse,
  type ApiError,
  type CatalogOverview,
  type CatalogResourcePathParams,
  type CatalogSyncBody,
  type ContentUpdateBody,
  defineRoute,
  type HttpMethod,
  listRoutes,
  type McpWithContent,
  type MetadataPatchBody,
  type OkResponse,
  ROUTES,
  type RouteKey,
  type RouteReq,
  type RouteRequest,
  type RouteRes,
  type RouteSpec,
  type ScheduleDeleteResponse,
  type ScheduledTaskListQuery,
  type ScheduleGetResponse,
  type ScheduleListQuery,
  type SchedulePathParams,
  type SchedulePreviewCronQuery,
  type SchedulePreviewQuery,
  type ScheduleRunResponse,
  type ScheduleWire,
  type SessionCreateBody,
  type SessionDeleteQuery,
  type SessionListQuery,
  type SessionPathParams,
  type SessionSpawnBody,
  type SessionSpawnRes,
  type SkillWithContent,
  type TaskActivityQuery,
  type TaskDeleteQuery,
  type TaskDispatchBody,
  type TaskListQuery,
  type TaskPathParams,
  type TaskScheduleCreateBody,
  type TaskSchedulePatchBody,
  type WorkspaceCreateBody,
  type WorkspaceCurrentPutBody,
  type WorkspaceCurrentRes,
  type WorkspacePatchBody,
  type WorkspacePathParams,
  type WorkspaceSummary,
} from "./contracts/routes.js";
export type { RuntimeInfo } from "./contracts/runtimes.js";
export type {
  ScheduleWireTarget,
  TaskScheduleTargetWire,
  TaskTargetData,
  TaskTargetPatch,
} from "./contracts/schedules.js";
export type { ServerConfig } from "./contracts/server-config.js";
export { makeTaskKindHandler, TaskScheduleTargetError } from "./wiring/schedule-task-handler.js";
export { type WorkspaceContext, WorkspaceHasLiveTasksError } from "./workspace-context.js";
