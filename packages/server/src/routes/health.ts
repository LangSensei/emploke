import type { HealthResponse } from "@emploke/api";
import { Hono } from "hono";

/**
 * GET /api/health — unauthenticated liveness + version surface.
 *
 * **Mount before any auth middleware** so the dashboard's backoff probe
 * can detect server-up without first having to acquire an API key. This
 * is intentional: an unauth health check leaks nothing more than "the
 * server is running and is on version X", both of which a network
 * scanner could derive from the connection itself.
 *
 * The `HealthResponse` wire shape lives in `@emploke/api` so the
 * dashboard, CLI, and external monitors can typecheck against it
 * without value-importing `@emploke/server`.
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
