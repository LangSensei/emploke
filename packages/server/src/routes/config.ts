import type { ServerConfig } from "@emploke/api";
import { Hono } from "hono";

/**
 * GET /api/config — returns the resolved server config. The deps are read
 * fresh on each request so dynamic fields (currently `currentWorkspace`)
 * stay accurate as the registry mutates.
 *
 * The `ServerConfig` wire shape lives in `@emploke/api` so the
 * dashboard and CLI can typecheck against it without value-importing
 * `@emploke/server`.
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
   * (TaskService.list() runs an indexed SELECT on every call). Operators
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
