import type { Logger } from "@emploke/logger";
import type { MiddlewareHandler } from "hono";

/**
 * Access-log middleware.
 *
 * Emits one structured log line per request at end-of-request, with
 * method, path, status, durationMs, and selected request context
 * (workspaceId from URL params, requestId from `c.var`, truncated
 * user-agent).
 *
 * Level depends on outcome:
 *   - status ≥ 500            → `error`
 *   - status ≥ 400            → `warn`
 *   - durationMs > {@link SLOW_REQUEST_MS} (and otherwise OK) → `warn`
 *   - everything else         → `info`
 *
 * Quiet paths (currently only `/api/health`) skip access logging
 * entirely — the dashboard and external liveness probes hit health
 * every few seconds and the noise drowns real signal.
 *
 * Order constraint: must run AFTER `requestLogger()` (reads
 * `c.var.logger`).
 */
const SLOW_REQUEST_MS = 2000;
const QUIET_PATHS = new Set(["/api/health"]);
const USER_AGENT_MAX = 80;

type Vars = { Variables: { requestId: string; logger: Logger } };

export function accessLog(): MiddlewareHandler<Vars> {
  return async (c, next) => {
    if (QUIET_PATHS.has(c.req.path)) {
      await next();
      return;
    }
    const start = performance.now();
    let thrown: unknown = null;
    try {
      await next();
    } catch (err) {
      thrown = err;
      throw err;
    } finally {
      const durationMs = Math.round(performance.now() - start);
      const status = c.res.status;
      const level: "info" | "warn" | "error" =
        thrown !== null || status >= 500
          ? "error"
          : status >= 400 || durationMs > SLOW_REQUEST_MS
            ? "warn"
            : "info";
      const logger = c.get("logger");
      const workspaceId = (() => {
        try {
          return c.req.param("id");
        } catch {
          return undefined;
        }
      })();
      logger[level](
        {
          method: c.req.method,
          path: c.req.routePath ?? c.req.path,
          status,
          durationMs,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          userAgent: c.req.header("user-agent")?.slice(0, USER_AGENT_MAX),
          ...(thrown !== null ? { thrown: true } : {}),
        },
        "http",
      );
    }
  };
}
