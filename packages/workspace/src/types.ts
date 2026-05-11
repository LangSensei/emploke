import path from "node:path";
import {
  CATALOG_SUBDIR,
  LOGS_SUBDIR,
  SESSIONS_SUBDIR,
  TASKS_SUBDIR,
  WORKFLOWS_SUBDIR,
} from "./constants.js";

/**
 * The workspace domain object — an emploke working unit identified by a
 * stable UUID, sitting inside a user-chosen working directory.
 *
 * `workdir` is the **only** filesystem field on the type. Everything
 * else is pure metadata that survives a backend swap (fs, sqlite,
 * remote service): `id` / `name` / `createdAt` / `defaults` are domain
 * data; `workdir` is the contract with the agents that emploke spawns
 * inside this workspace ("agent's working root").
 *
 * Notes:
 *   - The "metadata file" (`workspace.json`) and the directory layout
 *     (`tasks/`, `sessions/`, `catalog/` ...) are **implementation
 *     details of the FS repository**. Sqlite repositories would store
 *     the same `Workspace` shape as a row.
 *   - There is no `dir` / `sessionsDir` / `tasksDir` field — those were
 *     leaky abstractions over the previous "WorkspaceManager.open
 *     returns a path bag" design. Use `workspaceLayout(workdir)` (below)
 *     when you need the conventional sub-paths.
 *   - There is no `schemaVersion` field — it lives only inside the FS
 *     repository's wire format.
 */
export interface Workspace {
  /** Stable UUID assigned at creation. URL routing key. */
  readonly id: string;
  /** Display name (free-form text, 1-64 trimmed chars, no control chars). */
  readonly name: string;
  /** ISO 8601 UTC timestamp at creation. */
  readonly createdAt: string;
  /** Optional UX defaults for sessions/tasks dispatched in this workspace. */
  readonly defaults?: {
    readonly runtime?: string;
    readonly agent?: string;
  };
  /**
   * Absolute filesystem path the agents work under. Provided at
   * `init`-time (the HTTP route may default it to
   * `$EMPLOKE_HOME/workspaces/<id>/` when the caller omits it; the
   * manager itself always receives a concrete path). Never re-derived
   * after init. The conventional sub-paths (`<workdir>/tasks/<id>/`,
   * `<workdir>/sessions/<id>/`, etc.) are computed by `workspaceLayout`
   * for downstream consumers — they are NOT part of the domain type.
   */
  readonly workdir: string;
}

/**
 * Conventional sub-path layout under a workspace's `workdir`. Pure
 * function; no fs side effects. Used by WorkspaceManager + the
 * downstream package managers (TaskManager, SessionManager, Catalog)
 * to compute the directories agents and runtimes use.
 *
 * Keeping this as a **standalone helper** rather than baking the paths
 * into `Workspace` itself preserves the "domain type stays clean"
 * invariant: the `Workspace` type has no fs-knowledge fields beyond
 * `workdir`, so SQLite-backed callers can mint `Workspace` rows
 * without ever touching this helper.
 */
export interface WorkspaceLayout {
  readonly sessions: string;
  readonly tasks: string;
  readonly catalog: string;
  readonly workflows: string;
  readonly logs: string;
}

/** Compute every fixed-name subdirectory under `workdir`. */
export function workspaceLayout(workdir: string): WorkspaceLayout {
  const root = path.resolve(workdir);
  return {
    sessions: path.join(root, SESSIONS_SUBDIR),
    tasks: path.join(root, TASKS_SUBDIR),
    catalog: path.join(root, CATALOG_SUBDIR),
    workflows: path.join(root, WORKFLOWS_SUBDIR),
    logs: path.join(root, LOGS_SUBDIR),
  };
}
