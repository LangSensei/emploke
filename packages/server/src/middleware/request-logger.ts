import type { Logger } from "@emploke/logger";
import type { MiddlewareHandler } from "hono";

/**
 * Per-request child logger middleware.
 *
 * Builds a pino child logger bound to `{ requestId }` and stashes it on
 * `c.var.logger`. Routes call `c.get("logger")` and inherit the binding
 * automatically — they never have to thread `requestId` through their
 * own `meta` records.
 *
 * Order constraint: must run AFTER `requestId()` (reads `c.var.requestId`).
 *
 * Cost: pino's `child(bindings)` is cheap (allocates one extra object;
 * no new transport). A child instance per request is the recommended
 * pattern in pino's own docs.
 */
export function requestLogger(
  base: Logger,
): MiddlewareHandler<{ Variables: { requestId: string; logger: Logger } }> {
  return async (c, next) => {
    const requestId = c.get("requestId");
    c.set("logger", base.child({ requestId }));
    await next();
  };
}
