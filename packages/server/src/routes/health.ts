import type { HealthResponse } from "@emploke/api";
import { Hono } from "hono";

/**
 * GET /api/health — unauthenticated liveness + version surface.
 *
 * If a future auth middleware lands (today none exists; the server
 * binds loopback-only and delegates auth to operator-managed
 * transports — see `auth.ts`), mount it AFTER this route so the
 * dashboard's backoff probe can detect server-up without
 * authenticating. The endpoint exposes only `name`, `version`,
 * `startedAt`, and `uptimeSec` — nothing a network observer couldn't
 * already derive from the running socket.
 *
 * The `HealthResponse` wire shape lives in `@emploke/contracts`
 * (re-exported via `@emploke/api`) so the dashboard, CLI, and
 * external monitors can typecheck against it without value-importing
 * `@emploke/server`.
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
    const nowMs = now();
    const uptimeSec = Math.max(0, Math.floor((nowMs - deps.startedAtMs) / 1000));
    return c.json<HealthResponse>({
      status: "ok",
      name: deps.name,
      version: deps.version,
      startedAt: startedAtIso,
      uptimeSec,
      serverNow: new Date(nowMs).toISOString(),
    });
  });

  return app;
}
