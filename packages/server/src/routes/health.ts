import { Hono } from "hono";

/**
 * Shape returned by `GET /api/health`.
 *
 * Used by:
 *  - the dashboard's backoff probe — any 200 response means the server is
 *    alive, so the polling loop can resume from its baseline cadence
 *    instead of climbing the exponential ladder forever
 *  - external monitors / liveness checks (e.g. `curl -fsS /api/health`
 *    in a wrapper script) — `status: "ok"` is the contract
 *  - the dashboard's "About" surface — `version` tells the user (and
 *    issue-filers) which build of emploke they're running
 *
 * Sensitive values are deliberately NOT exposed: the endpoint is
 * unauthenticated so it can serve the backoff probe before the user has
 * supplied an API key, and so external monitors don't need credentials.
 * Anything you'd hide from a stranger on the network does not belong here.
 */
export interface HealthResponse {
  /**
   * Always `"ok"` for now. Reserved as an enum for the future case where
   * the server can self-report `"degraded"` (e.g. a runtime is missing,
   * fs is read-only). Clients should treat any non-`"ok"` value as
   * "server is up but something is wrong" rather than parse-faulting.
   */
  readonly status: "ok";
  /** Server package name, e.g. `"@emploke/server"`. */
  readonly name: string;
  /** Server semver, e.g. `"0.0.1"`. */
  readonly version: string;
  /** ISO 8601 UTC timestamp when this server process started. */
  readonly startedAt: string;
  /** Whole seconds since `startedAt`, computed at request time. */
  readonly uptimeSec: number;
}

/**
 * GET /api/health — unauthenticated liveness + version surface.
 *
 * **Mount before any auth middleware** so the dashboard's backoff probe
 * can detect server-up without first having to acquire an API key. This
 * is intentional: an unauth health check leaks nothing more than "the
 * server is running and is on version X", both of which a network
 * scanner could derive from the connection itself.
 *
 * `deps.now` is injected so tests can pin uptime; production passes
 * `() => Date.now()`.
 */
export function healthRoutes(deps: {
  readonly name: string;
  readonly version: string;
  readonly startedAtMs: number;
  readonly now?: () => number;
}): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => Date.now());
  const startedAtIso = new Date(deps.startedAtMs).toISOString();

  app.get("/", (c) => {
    const uptimeSec = Math.max(0, Math.floor((now() - deps.startedAtMs) / 1000));
    return c.json<HealthResponse>({
      status: "ok",
      name: deps.name,
      version: deps.version,
      startedAt: startedAtIso,
      uptimeSec,
    });
  });

  return app;
}
