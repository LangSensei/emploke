/**
 * @emploke/paths — resolve emploke's server-global filesystem layout.
 *
 * Owns every path under `<EMPLOKE_HOME>` that is **shared across the
 * server lifetime** (not per-request, not per-workspace). Today that's
 * five files / directories:
 *
 *   - `<home>/workspaces.json` — registry of registered workspaces
 *   - `<home>/workspaces/` — parent dir for auto-allocated workspaces
 *   - `<home>/logs/` — server's rotated log files (pino-roll)
 *   - `<home>/runtime.json` — CLI lifecycle breadcrumb (pid + port + apiKey)
 *   - `<home>/shared/` — runtime adapters' `${globalDir}` placeholder root
 *
 * One overrideable knob:
 *
 *   - `EMPLOKE_HOME` — the user-level root. Default `~/.emploke`.
 *
 * Everything else is derived from `<home>` and not independently
 * overrideable — those locations are part of the contract emploke
 * promises to its CLI clients, runtime adapters, and on-disk consumers.
 *
 * Per-workspace paths (`<workspace>/sessions/`, `<workspace>/tasks/`,
 * `<workspace>/catalog/`, ...) are NOT this module's concern — they're
 * computed by `@emploke/workspace`'s `workspaceLayout(workdir)` and
 * passed to entity managers as constructor arguments.
 *
 * Pure: no filesystem access, no process state. Callers pass `process.env`
 * (or a stub for testing); the function returns a plain record.
 */

import { homedir } from "node:os";
import path from "node:path";

/** Fallback `~/.emploke` when no `EMPLOKE_HOME` env var is set. */
export const DEFAULT_EMPLOKE_HOME: string = path.join(homedir(), ".emploke");

/** Filename (under `<home>`) for the workspace registry. */
export const WORKSPACES_REGISTRY_FILE = "workspaces.json";

/** Subdirectory (under `<home>`) where the server writes its rotated log files. */
export const LOGS_SUBDIR = "logs";

/**
 * Filename (under `<home>`) for the CLI lifecycle breadcrumb. Written by
 * `emploke start`, read by `emploke status` / `stop` / `connect`, deleted
 * by `emploke stop`. Records pid + host + port + apiKey of the running
 * server so a later CLI invocation can find and talk to it.
 */
export const RUNTIME_FILE_NAME = "runtime.json";

/**
 * Subdirectory (under `<home>`) used by runtime adapters as the resolved
 * value for the `${globalDir}` MCP placeholder. Stable per-machine path
 * shared across every workspace and runtime — spec authors get to write
 * `${globalDir}/some-state.db` without baking host paths into JSON.
 */
export const SHARED_SUBDIR = "shared";

/**
 * Subdirectory (under `<home>`) where the server auto-allocates new
 * workspace directories when the user creates a workspace without
 * specifying a `workdir`. Each auto-allocated workspace lives at
 * `<home>/workspaces/<uuid>/`. Users who explicitly pick their own
 * `workdir` never touch this subdir.
 */
export const WORKSPACES_PARENT_SUBDIR = "workspaces";

/**
 * Stable text written to the `_readme` field of every server-managed
 * JSON metadata file (`workspaces.json`, `<workspace>/workspace.json`,
 * `<home>/runtime.json`). Visible to anyone who `cat`s the file,
 * silently ignored on read by every emploke parser.
 *
 * Its only audience is a human inspecting the file by hand: the field
 * exists so they immediately see this is server-managed state and find
 * the contract that explains why hand-editing is unsupported. Keep the
 * sentence short — it ships in every metadata file.
 *
 * Single-sourced here so `@emploke/workspace` and `@emploke/cli`
 * (today's two writers) emit the same text without depending on each
 * other. Bump only when the README anchor or the URL moves.
 */
export const SERVER_MANAGED_README =
  "managed by emploke; do not edit by hand — see https://github.com/LangSensei/emploke#filesystem-contract";

/**
 * Resolved emploke paths derived from environment. All paths are absolute
 * (`path.resolve`-d) so callers don't have to worry about cwd-relative input
 * sneaking in via env.
 */
export interface EmplokePaths {
  /** User-level root, e.g. `~/.emploke`. */
  readonly home: string;
  /** Path to the workspace registry file, `<home>/workspaces.json`. */
  readonly registryFile: string;
  /**
   * Directory the server writes its rotated log files into,
   * `<home>/logs`. Created on demand by `@emploke/logger`.
   */
  readonly logsDir: string;
  /**
   * Path to the CLI lifecycle breadcrumb, `<home>/runtime.json`. Created
   * by `emploke start`, deleted by `emploke stop`. Reading it tells you
   * pid + host + port + apiKey of the locally-running server.
   */
  readonly runtimeFile: string;
  /**
   * Directory used by runtime adapters as the `${globalDir}` placeholder
   * root, `<home>/shared`. Stable per-machine path that an MCP spec can
   * reference without knowing the host's `EMPLOKE_HOME` override.
   */
  readonly sharedDir: string;
  /**
   * Parent directory the server auto-allocates new workspace dirs under,
   * `<home>/workspaces`. Each workspace created without an explicit
   * `workdir` lives at `<sharedWorkspacesDir>/<uuid>/`.
   */
  readonly sharedWorkspacesDir: string;
}

/**
 * Resolve the emploke path layout from environment variables. Pure: no fs
 * access, no defaulting to `process.env` — callers pass it in (or a stub).
 *
 * Honoured env vars:
 *   - `EMPLOKE_HOME` overrides `home` (and, transitively, every derived path).
 *
 * Empty-string overrides (`EMPLOKE_HOME=""`) are treated as unset.
 */
export function resolveEmplokePaths(env: NodeJS.ProcessEnv = {}): EmplokePaths {
  const homeOverride = env.EMPLOKE_HOME;
  const home = path.resolve(
    homeOverride && homeOverride.length > 0 ? homeOverride : DEFAULT_EMPLOKE_HOME,
  );

  return {
    home,
    registryFile: path.join(home, WORKSPACES_REGISTRY_FILE),
    logsDir: path.join(home, LOGS_SUBDIR),
    runtimeFile: path.join(home, RUNTIME_FILE_NAME),
    sharedDir: path.join(home, SHARED_SUBDIR),
    sharedWorkspacesDir: path.join(home, WORKSPACES_PARENT_SUBDIR),
  };
}
