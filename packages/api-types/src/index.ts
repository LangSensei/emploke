/**
 * Shared contracts between emploke transports (HTTP server, CLI client,
 * future MCP server). Pure types + constants + path resolvers. NO
 * business logic, NO I/O, NO transport-specific code.
 *
 * Why this package exists:
 *   - server (HTTP) and cli (argv) both speak the same contracts:
 *       1. HTTP routes / request / response shapes (route manifest)
 *       2. Out-of-band IPC files (runtime.json, logs/)
 *       3. The shared root path (EMPLOKE_HOME)
 *   - If server "owns" these and cli imports from server, we have a
 *     transport ↔ transport reverse dep. The clean fix is a contract
 *     package both transports depend on.
 *
 * Note: business-domain paths (workspace registry DB location, runtime
 * adapter shared dir) live on the owning domain pkgs, not here. This
 * pkg only owns paths that cross the server ↔ cli boundary.
 *
 * The workspace pkgs listed in this pkg's `dependencies`
 * (`@emploke/catalog`, `@emploke/runtime`, `@emploke/schedule`,
 * `@emploke/session`, `@emploke/task`) are **type-only** consumers —
 * `routes.ts` and `plan-to-manifest.ts` `import type` the wire-shape
 * source types from them so the runtime emit stays a tree-shake-friendly
 * leaf for cli + dashboard. A non-type import would silently pull the
 * whole upstream graph into every consumer's bundle.
 */

export {
  DEFAULT_EMPLOKE_HOME,
  LOGS_SUBDIR,
  logsDir,
  RUNTIME_FILE_NAME,
  type RuntimeFile,
  resolveEmplokeHome,
  runtimeFilePath,
} from "./emploke-home.js";

export type { HealthResponse } from "./health.js";
export type {
  AgentManifestNode,
  McpManifestNode,
  OrphanManifestEntry,
  ResolveManifest,
  ResolveManifestNode,
  SkillManifestNode,
} from "./plan-to-manifest.js";
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
} from "./routes.js";
export type { RuntimeInfo } from "./runtimes.js";
export type { ServerConfig } from "./server-config.js";
