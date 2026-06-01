import { fetchJson, jsonInit, mutate, mutateJson, workspacePrefix } from "./http.js";

export interface SessionView {
  id: string;
  workdir: string;
  agent: string;
  /** Runtime kind (e.g. "copilot"). */
  runtime: string;
  /** Native session ID assigned by the runtime, or null if not yet known. */
  runtimeSessionId: string | null;
  /** ISO 8601 string. */
  createdAt: string;
  /** ISO 8601 string of the runtime's last observed activity, or null. */
  lastActiveAt: string | null;
  /** Short human-readable preview from the runtime, or null. */
  preview: string | null;
  /**
   * Mode the user chose for the most recent successful launch of this
   * session, or null if it has never been launched. Drives the default
   * action of the Resume split button.
   */
  lastLaunchMode: "local" | "remote" | null;
}

export interface LaunchCommand {
  cmd: string;
  args: string[];
  cwd: string;
  display: string;
}

export interface ListSessionsOpts {
  agent?: string;
  /** ISO 8601 timestamp; sessions created before this are excluded server-side. */
  createdSince?: string;
  /**
   * ISO 8601 timestamp; sessions whose lastActiveAt is before this (or
   * null) are excluded server-side. More expensive than createdSince
   * because the server must call runtime.refresh() before filtering.
   */
  activeSince?: string;
}

export const listSessions = (opts: ListSessionsOpts = {}): Promise<SessionView[]> => {
  const params = new URLSearchParams();
  if (opts.agent) params.set("agent", opts.agent);
  if (opts.createdSince) params.set("createdSince", opts.createdSince);
  if (opts.activeSince) params.set("activeSince", opts.activeSince);
  const qs = params.toString();
  return fetchJson<SessionView[]>(`${workspacePrefix()}/sessions${qs ? `?${qs}` : ""}`, "sessions");
};

export const getSession = (id: string): Promise<SessionView> =>
  fetchJson<SessionView>(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}`, "session");

export const createSession = async (agent: string, runtime?: string): Promise<SessionView> => {
  const body: Record<string, string> = { agent };
  if (runtime !== undefined) body.runtime = runtime;
  return mutateJson<SessionView>(`${workspacePrefix()}/sessions`, jsonInit("POST", body));
};

export const deleteSession = (id: string, opts?: { purge?: boolean }) => {
  // Default ("archive") removes only the session metadata row — workdir
  // contents (AGENTS.md + agent-produced files) and the runtime
  // adapter's per-session state both stay on disk so the user can
  // recover or inspect them later. `{ purge: true }` is the hard-delete
  // path: row + workdir + runtime state, all gone. The confirm modal
  // exposes this as a single checkbox.
  const qs = opts?.purge ? "?purge=1" : "";
  return mutate(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}${qs}`, {
    method: "DELETE",
  });
};

export interface SpawnSuccess {
  ok: true;
  launcher: string;
  display: string;
}

export interface SpawnFailure {
  ok: false;
  error: string;
  code?: string;
  display: string;
}

export type SpawnResult = SpawnSuccess | SpawnFailure;

export const spawnSession = async (
  id: string,
  opts: { remote?: boolean } = {},
): Promise<SpawnResult> =>
  mutateJson<SpawnResult>(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(opts.remote === true ? { remote: true } : {}) }),
  });
