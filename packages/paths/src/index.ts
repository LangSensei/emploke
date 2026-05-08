/**
 * @emploke/paths — resolve emploke's user-level filesystem layout.
 *
 * Two layers of overrideable defaults:
 *
 *   1. `EMPLOKE_HOME` — the user-level root. Default `~/.emploke`.
 *   2. `EMPLOKE_CATALOG_DIR` — global asset library. Default `<home>/catalog`.
 *      Independently overrideable so a team can point catalog at a shared
 *      read-only volume while keeping per-user state under `~/.emploke`.
 *
 * Everything else (`workspaces/`, `workspaces.json`) is derived from `<home>`
 * and not independently overrideable — those locations are part of the
 * contract emploke promises to the user.
 *
 * Pure: no filesystem access, no process state. Callers pass `process.env`
 * (or a stub for testing); the function returns a plain record.
 */

import { homedir } from "node:os";
import path from "node:path";

/** Fallback `~/.emploke` when no `EMPLOKE_HOME` env var is set. */
export const DEFAULT_EMPLOKE_HOME: string = path.join(homedir(), ".emploke");

/** Subdirectory of `<home>` that holds the global catalog. */
export const CATALOG_SUBDIR = "catalog";

/** Subdirectory of `<home>` that holds workspace directories created by emploke itself. */
export const WORKSPACES_SUBDIR = "workspaces";

/** Filename (under `<home>`) for the workspace registry. */
export const WORKSPACES_REGISTRY_FILE = "workspaces.json";

/** Name of the workspace emploke auto-creates on first run. */
export const DEFAULT_WORKSPACE_NAME = "default";

/**
 * Resolved emploke paths derived from environment. All paths are absolute
 * (`path.resolve`-d) so callers don't have to worry about cwd-relative input
 * sneaking in via env.
 */
export interface EmplokePaths {
  /** User-level root, e.g. `~/.emploke`. */
  readonly home: string;
  /** Global catalog directory. May live outside `home` if explicitly overridden. */
  readonly catalogDir: string;
  /** Default location for emploke-managed workspaces, `<home>/workspaces`. */
  readonly workspacesDir: string;
  /** Path to the workspace registry file, `<home>/workspaces.json`. */
  readonly registryFile: string;
  /** Path to the auto-created default workspace, `<home>/workspaces/default`. */
  readonly defaultWorkspaceDir: string;
}

/**
 * Resolve the emploke path layout from environment variables. Pure: no fs
 * access, no defaulting to `process.env` — callers pass it in (or a stub).
 *
 * Honoured env vars:
 *   - `EMPLOKE_HOME` overrides `home` (and, transitively, every derived path
 *      that wasn't itself overridden).
 *   - `EMPLOKE_CATALOG_DIR` overrides `catalogDir` independently of `home`.
 *
 * Empty-string overrides (`EMPLOKE_HOME=""`) are treated as unset.
 */
export function resolveEmplokePaths(env: NodeJS.ProcessEnv = {}): EmplokePaths {
  const homeOverride = env.EMPLOKE_HOME;
  const home = path.resolve(
    homeOverride && homeOverride.length > 0 ? homeOverride : DEFAULT_EMPLOKE_HOME,
  );

  const catalogOverride = env.EMPLOKE_CATALOG_DIR;
  const catalogDir = path.resolve(
    catalogOverride && catalogOverride.length > 0
      ? catalogOverride
      : path.join(home, CATALOG_SUBDIR),
  );

  const workspacesDir = path.join(home, WORKSPACES_SUBDIR);
  const registryFile = path.join(home, WORKSPACES_REGISTRY_FILE);
  const defaultWorkspaceDir = path.join(workspacesDir, DEFAULT_WORKSPACE_NAME);

  return { home, catalogDir, workspacesDir, registryFile, defaultWorkspaceDir };
}
