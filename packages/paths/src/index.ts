/**
 * @emploke/paths — resolve emploke's user-level filesystem layout.
 *
 * One overrideable knob:
 *
 *   - `EMPLOKE_HOME` — the user-level root. Default `~/.emploke`.
 *
 * Everything else (`workspaces.json`) is derived from `<home>` and not
 * independently overrideable — those locations are part of the contract
 * emploke promises to the user.
 *
 * The catalog is no longer a global concept; each workspace owns a
 * `<workspace>/catalog/` subdir managed by `@emploke/workspace`. There is
 * therefore no `catalogDir` field here.
 *
 * Workspace directories themselves are user-chosen (no auto-created
 * default), so this module also no longer exposes a `workspacesDir` /
 * `defaultWorkspaceDir` — only the registry that records where the user
 * placed each one.
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

  const registryFile = path.join(home, WORKSPACES_REGISTRY_FILE);

  return { home, registryFile };
}
