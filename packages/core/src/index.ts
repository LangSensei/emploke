/**
 * @emploke/core — orchestration root.
 *
 * Composes entity-layer pkgs (workspace + session + task + catalog +
 * runtime) into a single `Application` handle for the HTTP server,
 * CLI in-process mode, MCP server, or future agent SDKs.
 */
export {
  type Application,
  type ApplicationOptions,
  composeApplication,
  type SpawnFn,
  type SpawnSessionResult,
} from "./application.js";
export { type WorkspaceContext, WorkspaceHasLiveTasksError } from "./workspace-context.js";
