import { Hono } from "hono";

/**
 * Resolved server configuration values that the dashboard needs to display
 * accurately. Sourcing these from the server (rather than hardcoding the
 * defaults in dashboard copy) means the UI tells the user the truth even
 * when env overrides like `EMPLOKE_SESSIONS_DIR` or `EMPLOKE_CATALOG_DIR`
 * are in effect.
 *
 * Sensitive values are NOT exposed: the dashboard runs in single-user mode
 * on the same host as the server, so absolute paths are appropriate.
 */
export interface ServerConfig {
  /** Absolute path to the catalog directory (resolves `EMPLOKE_CATALOG_DIR`). */
  catalogDir: string;
  /** Absolute path to the sessions root (resolves `EMPLOKE_SESSIONS_DIR`). */
  sessionsRoot: string;
  /** Host the server is bound to (e.g. `127.0.0.1` or `0.0.0.0`). */
  host: string;
  /** Port the server is listening on. */
  port: number;
  /** Native path separator on the server's OS (`\\` on Windows, `/` elsewhere). */
  pathSeparator: string;
}

/** GET /api/config — returns the resolved server config. */
export function configRoutes(config: ServerConfig): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(config));
  return app;
}
