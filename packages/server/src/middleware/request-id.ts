import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Per-request id middleware.
 *
 * Produces a short, opaque id for every request (used as a correlation
 * key by the request-scoped logger and echoed back in the
 * `x-request-id` response header). When the client supplies its own
 * `x-request-id` header (e.g. a downstream proxy or front-end client
 * already participating in distributed tracing) we honour it as long
 * as it looks reasonable — otherwise we mint a fresh 8-char id.
 *
 * Why 8 chars: long enough to be unique across the volume of
 * concurrent requests a single emploke server sees (single-host, small
 * team), short enough to keep log lines readable. Collision risk is
 * irrelevant in practice — these are per-request, not persisted.
 *
 * Stashed on `c.var.requestId`. Routes can read it via
 * `c.get("requestId")`; the request-scoped logger middleware folds it
 * into every line the route emits.
 */
const MAX_INCOMING_LEN = 80;
const ID_RE = /^[\w.\-_]+$/;

export function requestId(): MiddlewareHandler<{ Variables: { requestId: string } }> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const id =
      typeof incoming === "string" &&
      incoming.length > 0 &&
      incoming.length <= MAX_INCOMING_LEN &&
      ID_RE.test(incoming)
        ? incoming
        : randomUUID().slice(0, 8);
    c.set("requestId", id);
    c.header("x-request-id", id);
    await next();
  };
}
