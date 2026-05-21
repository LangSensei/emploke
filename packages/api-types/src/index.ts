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
