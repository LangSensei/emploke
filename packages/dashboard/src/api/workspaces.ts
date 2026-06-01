import { fetchJson, jsonInit, mutate, mutateJson } from "./http.js";

/**
 * A registered workspace, as returned by the `/api/workspaces` family of
 * endpoints. The shape mirrors the server's `Workspace` domain type — flat,
 * no `metadata` wrapper, no `schemaVersion` (that's a Repository-internal
 * concern). `workspaceDir` is the only filesystem path field; everything
 * else is pure metadata that survives a backend swap (FS today, SQLite
 * tomorrow).
 */
export interface WorkspaceListItem {
  /** Opaque UUID; the URL routing key. */
  id: string;
  /** Display name (free-form text, 1-64 trimmed chars). */
  name: string;
  /** ISO 8601 UTC timestamp at creation. */
  createdAt: string;
  /** Absolute filesystem path the workspace lives under. */
  workspaceDir: string;
}

export const listWorkspaces = (): Promise<WorkspaceListItem[]> =>
  fetchJson<WorkspaceListItem[]>("/api/workspaces", "workspaces");

export const getServerCurrentWorkspace = (): Promise<{ id: string | null }> =>
  fetchJson<{ id: string | null }>("/api/workspaces/current", "current-workspace");

export const setServerCurrentWorkspace = (id: string): Promise<void> =>
  mutate("/api/workspaces/current", jsonInit("PUT", { id }));

/**
 * Created workspace as returned by `POST /api/workspaces`. Identical shape
 * to {@link WorkspaceListItem} — kept as a separate type only for callsite
 * clarity (the server returns 201 + the same body).
 */
export type CreatedWorkspace = WorkspaceListItem;

export const addWorkspace = async (opts: {
  name: string;
  /** Optional. When omitted, the server creates a fresh
   *  `<EMPLOKE_HOME>/workspaces/<uuid>/` directory. */
  workspaceDir?: string;
}): Promise<CreatedWorkspace> => {
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.workspaceDir !== undefined && opts.workspaceDir !== "")
    body.workspaceDir = opts.workspaceDir;
  return mutateJson<CreatedWorkspace>("/api/workspaces", jsonInit("POST", body));
};

/**
 * Remove a workspace from the registry.
 *
 * Default behaviour: metadata-only — the registry row in `global.db`
 * is deleted but the user's directory contents (their files, plus any
 * agent-produced sessions/, tasks/) stay on disk untouched.
 *
 * Pass `{ purge: true }` to also rm every emploke-owned subdirectory under
 * the workspace's workspaceDir. The workspaceDir itself is never removed —
 * that's user-owned and outside the manager's purview.
 */
export const removeWorkspace = (id: string, opts?: { purge?: boolean }) => {
  const qs = opts?.purge ? "?purge=1" : "";
  return mutate(`/api/workspaces/${encodeURIComponent(id)}${qs}`, { method: "DELETE" });
};

export const updateWorkspaceMetadata = async (
  id: string,
  patch: { name?: string },
): Promise<WorkspaceListItem> =>
  mutateJson<WorkspaceListItem>(
    `/api/workspaces/${encodeURIComponent(id)}`,
    jsonInit("PATCH", patch),
  );
