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
 */
export function bearerAuth(expected: string) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | undefined> => {
    const header = c.req.header("authorization");
    let presented: string | null = null;
    if (header?.toLowerCase().startsWith("bearer ")) {
      presented = header.slice(7).trim();
    } else {
      const q = c.req.query("apiKey");
      if (typeof q === "string" && q.length > 0) presented = q;
    }
    if (presented === null || !constantTimeEqual(presented, expected)) {
      return c.json({ error: "unauthorized", code: "Unauthorized" }, 401);
    }
    await next();
    return undefined;
  };
}
