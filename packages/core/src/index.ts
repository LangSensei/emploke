/**
 * @emploke/core — orchestration root.
 *
 * Composes entity-layer pkgs (workspace + session + task + catalog +
 * runtime) into a single `EmplokeCore` handle for the HTTP server,
 * CLI in-process mode, MCP server, or future agent SDKs.
 */
export {
  composeEmplokeCore,
  type EmplokeCore,
  type EmplokeCoreOptions,
  WorkspaceHasLiveTasksError,
  type WorkspaceRuntime,
  WorkspaceRuntimeCache,
} from "./runtime.js";
