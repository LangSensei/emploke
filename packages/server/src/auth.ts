import type { Logger } from "@emploke/logger";
import type { Context } from "hono";

/**
 * Loopback addresses that don't require auth: anything that's only
 * reachable from this machine. We check the literal configured value
 * rather than resolving DNS — the user typed it; the user owns it.
 *
 * Anything else (`0.0.0.0`, a LAN IP, a public hostname) is treated as
 * "exposed to the network" and the caller must gate it with an API key.
 */
export function isLoopbackBind(host: string): boolean {
  if (host === "127.0.0.1" || host === "localhost") return true;
  if (host === "::1" || host === "[::1]") return true;
  // Other 127.x.x.x addresses are also loopback per RFC 5735, but we
  // expect production users to spell them as 127.0.0.1.
  return host.startsWith("127.");
}

/**
 * Refuse to start when the server would be reachable from the network
 * without authentication. The check runs before any port binding so a
 * misconfigured deployment fails closed at startup rather than silently
 * exposing destructive endpoints (DELETE /api/skills/:name etc.).
 */
export function assertBindIsSafe(host: string, key: string | undefined): void {
  if (isLoopbackBind(host)) return;
  if (key && key.trim() !== "") return;
  throw new Error(
    `Refusing to bind to ${host} without authentication. Either:\n` +
      `  - bind to a loopback address (EMPLOKE_HOST=127.0.0.1, the default), or\n` +
      `  - set EMPLOKE_API_KEY=<token> to require Bearer auth on /api/* requests.\n` +
      `Without one of these, anyone on this network could call destructive endpoints ` +
      `(DELETE /api/skills/:name, POST /api/sessions/:id/spawn, etc.).`,
  );
}

/**
 * Length-safe constant-time string compare. Avoids the timing oracle that
 * a naïve `a === b` introduces when one operand is attacker-controlled
 * (Node's `===` short-circuits on the first mismatched character).
 *
 * We intentionally don't use `crypto.timingSafeEqual` because it requires
 * equal-length Buffers and our inputs are arbitrary strings; manually
 * comparing char codes is just as constant-time within the same length
 * and avoids the allocation footgun.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Hono middleware that requires `Authorization: Bearer <key>`. A
 * `?apiKey=<key>` query string is also accepted as a fallback for
 * browsers that can't easily set headers, but **prefer the Bearer
 * header in production**: query parameters are recorded in HTTP access
 * logs (nginx, upstream proxies, browser history, Referer headers when
 * the page links out), so a key sent via query is far more likely to
 * leak than one sent in the header.
 *
 * Compares the presented key with `expected` in constant time. Only
 * mounted by `index.ts` when `EMPLOKE_API_KEY` is set — when unset
 * (loopback-only deployment) requests pass through without this gate.
 *
 * Returns a Hono middleware function (async (c, next) => …). Failures
 * respond with 401 + `{ error: "unauthorized", code: "Unauthorized" }`
 * so the dashboard can branch on `code` like with other typed errors.
 *
 * **Auth events**: when a request is rejected, a `warn`-level structured
 * log line is emitted via the request-scoped logger (when one is
 * available on `c.var.logger`) recording the failure mode (missing
 * header / wrong key), the request path, and a sanitised user-agent.
 * **The presented key is never logged** — only its presence and a
 * length-bucketed fingerprint, so brute-force probing leaves a signal
 * without the log itself becoming a credential leak vector.
 */
export function bearerAuth(expected: string) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | undefined> => {
    const header = c.req.header("authorization");
    let presented: string | null = null;
    let mode: "header" | "query" | "absent" = "absent";
    if (header?.toLowerCase().startsWith("bearer ")) {
      presented = header.slice(7).trim();
      mode = "header";
    } else {
      const q = c.req.query("apiKey");
      if (typeof q === "string" && q.length > 0) {
        presented = q;
        mode = "query";
      }
    }
    if (presented === null || !constantTimeEqual(presented, expected)) {
      // Request-scoped logger is set by `requestLogger` middleware;
      // when missing (e.g. tests that mount bearerAuth standalone) we
      // skip the log without throwing.
      const logger = (c.get as unknown as (k: string) => unknown)("logger") as Logger | undefined;
      if (logger !== undefined) {
        logger.warn(
          {
            path: c.req.path,
            method: c.req.method,
            credentialMode: mode,
            credentialLen: presented?.length ?? 0,
            userAgent: c.req.header("user-agent")?.slice(0, 80),
          },
          "auth: bearer check failed",
        );
      }
      return c.json({ error: "unauthorized", code: "Unauthorized" }, 401);
    }
    await next();
    return undefined;
  };
}
