import path from "node:path";
import { LOGS_SUBDIR, SESSIONS_SUBDIR, TASKS_SUBDIR, WORKFLOWS_SUBDIR } from "./constants.js";

/**
 * Self-describing metadata persisted at `<workspace>/workspace.json`.
 *
 * Narrow on purpose:
 *   - `name` is the canonical user-facing name. The `WorkspaceRegistry` uses
 *     this same value (or one chosen at add time) as the URL identifier.
 *   - `defaults` are optional UX hints (e.g. dashboard pre-selects a
 *     runtime/agent when creating a session).
 *   - Future fields (`manifest` for version pins, `permissions`, …) bump
 *     `schemaVersion`; current builds reject mismatched versions on read.
 */
export interface WorkspaceMetadata {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly createdAt: string;
  readonly defaults?: {
    readonly runtime?: string;
    readonly agent?: string;
  };
}

/**
 * Resolved view of a workspace on disk. Every directory path is absolute
 * (`path.resolve`-d) and computed deterministically from `dir`.
 */
export interface Workspace {
  readonly dir: string;
  readonly metadata: WorkspaceMetadata;
  readonly sessionsDir: string;
  readonly tasksDir: string;
  readonly workflowsDir: string;
  readonly logsDir: string;
}

/** Compute every fixed-name subdirectory under `dir`. */
export function workspaceSubdirs(
  dir: string,
): Pick<Workspace, "sessionsDir" | "tasksDir" | "workflowsDir" | "logsDir"> {
  const root = path.resolve(dir);
  return {
    sessionsDir: path.join(root, SESSIONS_SUBDIR),
    tasksDir: path.join(root, TASKS_SUBDIR),
    workflowsDir: path.join(root, WORKFLOWS_SUBDIR),
    logsDir: path.join(root, LOGS_SUBDIR),
  };
}

/**
 * One entry in the home-level workspace registry. `name` is the routing
 * identifier (URL segment); `path` is the absolute filesystem location.
 *
 * `lastOpenedAt` is bumped by `WorkspaceRegistry.setCurrent`; it's used by
 * the dashboard to surface "recently opened" workspaces. Optional because
 * an entry may have been added but never selected.
 */
export interface RegistryEntry {
  readonly name: string;
  readonly path: string;
  readonly lastOpenedAt?: string;
}

/** Wire shape of `$EMPLOKE_HOME/workspaces.json`. */
export interface RegistryFile {
  readonly schemaVersion: 1;
  readonly entries: readonly RegistryEntry[];
  /** Name of the most-recently-selected workspace, or undefined. */
  readonly currentName?: string;
}
