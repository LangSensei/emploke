import { Hono } from "hono";

/**
 * Resolved server configuration values that the dashboard needs to display
 * accurately. Sourcing these from the server (rather than hardcoding the
 * defaults in dashboard copy) means the UI tells the user the truth even
 * when an env override like `EMPLOKE_HOME` is in effect.
 *
 * Sensitive values are NOT exposed: the dashboard runs in single-user mode
 * on the same host as the server, so absolute paths are appropriate.
 *
 * `currentWorkspace` reflects the registry's last-selected workspace id at
 * the moment of the request — it's a hint for the dashboard's "open this
 * workspace on first load" UX, not a binding contract.
 *
 * The catalog is per-workspace (lives at `<workspace>/catalog/`) and is
 * therefore NOT a global config field — it's surfaced by the workspace's
 * metadata endpoint instead.
 */
export interface ServerConfig {
  /** User-level emploke root (resolves `EMPLOKE_HOME`). */
  emplokeHome: string;
  /** Currently-selected workspace id (UUID) from the registry, or null. */
  currentWorkspace: string | null;
  /** Host the server is bound to (e.g. `127.0.0.1` or `0.0.0.0`). */
  host: string;
  /** Port the server is listening on. */
  port: number;
  /** Native path separator on the server's OS (`\\` on Windows, `/` elsewhere). */
  pathSeparator: string;
  /** Tunables consumed by the dashboard's task list view. */
  tasks: {
    /**
     * How often the dashboard re-fetches the task list while at least one
     * task is `running` or `not_started`. Stops polling when every task is
     * terminal. The server owns this value so it can be tuned without
     * shipping a new dashboard build (and so we don't hard-code a
     * UX-shaping constant inside React).
     */
    pollIntervalMs: number;
  };
}

/**
 * GET /api/config — returns the resolved server config. The deps are read
 * fresh on each request so dynamic fields (currently `currentWorkspace`)
 * stay accurate as the registry mutates.
 */
export function configRoutes(deps: {
  emplokeHome: string;
  host: string;
  port: number;
  pathSeparator: string;
  currentWorkspace: () => Promise<string | null> | string | null;
  /**
   * Optional override for the dashboard task-list poll cadence. Defaults
   * to 4000 ms — chosen as a tradeoff between snappiness and server load
   * (TaskManager.list() runs an indexed SELECT on every call). Operators
   * can lower this for faster UI feedback at the cost of more reads,
   * or raise it for very large workspaces.
   */
  taskPollIntervalMs?: number;
}): Hono {
  const app = new Hono();
  const taskPollIntervalMs = deps.taskPollIntervalMs ?? 4000;
  app.get("/", async (c) =>
    c.json<ServerConfig>({
      emplokeHome: deps.emplokeHome,
      currentWorkspace: await deps.currentWorkspace(),
      host: deps.host,
      port: deps.port,
      pathSeparator: deps.pathSeparator,
      tasks: { pollIntervalMs: taskPollIntervalMs },
    }),
  );
  return app;
}
