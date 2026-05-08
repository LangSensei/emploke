import { Hono } from "hono";

/**
 * Resolved server configuration values that the dashboard needs to display
 * accurately. Sourcing these from the server (rather than hardcoding the
 * defaults in dashboard copy) means the UI tells the user the truth even
 * when env overrides like `EMPLOKE_HOME`, `EMPLOKE_CATALOG_DIR`, or
 * `EMPLOKE_WORKSPACE` are in effect.
 *
 * Sensitive values are NOT exposed: the dashboard runs in single-user mode
 * on the same host as the server, so absolute paths are appropriate.
 *
 * `currentWorkspace` reflects the registry's last-selected workspace at
 * the moment of the request — it's a hint for the dashboard's "open this
 * workspace on first load" UX, not a binding contract.
 */
export interface ServerConfig {
  /** User-level emploke root (resolves `EMPLOKE_HOME`). */
  emplokeHome: string;
  /** Absolute path to the catalog directory (resolves `EMPLOKE_CATALOG_DIR`). */
  catalogDir: string;
  /** Currently-selected workspace name from the registry, or null. */
  currentWorkspace: string | null;
  /** Host the server is bound to (e.g. `127.0.0.1` or `0.0.0.0`). */
  host: string;
  /** Port the server is listening on. */
  port: number;
  /** Native path separator on the server's OS (`\\` on Windows, `/` elsewhere). */
  pathSeparator: string;
}

/**
 * GET /api/config — returns the resolved server config. The deps are read
 * fresh on each request so dynamic fields (currently `currentWorkspace`)
 * stay accurate as the registry mutates.
 */
export function configRoutes(deps: {
  emplokeHome: string;
  catalogDir: string;
  host: string;
  port: number;
  pathSeparator: string;
  currentWorkspace: () => string | null;
}): Hono {
  const app = new Hono();
  app.get("/", (c) =>
    c.json<ServerConfig>({
      emplokeHome: deps.emplokeHome,
      catalogDir: deps.catalogDir,
      currentWorkspace: deps.currentWorkspace(),
      host: deps.host,
      port: deps.port,
      pathSeparator: deps.pathSeparator,
    }),
  );
  return app;
}
