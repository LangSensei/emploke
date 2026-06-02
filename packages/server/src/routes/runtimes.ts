import type { RuntimeInfo } from "@emploke/api-types";
import type { RuntimeRegistry } from "@emploke/runtime";
import { Hono } from "hono";

/**
 * Routes for /api/runtimes — exposes the registered runtime kinds AND
 * each runtime's advertised capability flags so the dashboard / future
 * CLI can conditionally enable UI affordances (e.g. a "Spawn remote"
 * button only renders enabled when the active runtime sets
 * `capabilities.remoteSession === true`).
 *
 * The `RuntimeInfo` wire shape lives in `@emploke/api-types` so
 * dashboard / CLI consumers can typecheck against it without
 * value-importing `@emploke/server`.
 */
export function runtimesRoutes(registry: RuntimeRegistry): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const out: RuntimeInfo[] = registry.kinds().map((kind) => {
      const rt = registry.get(kind);
      return {
        kind,
        capabilities: { ...(rt.capabilities ?? {}) },
      };
    });
    return c.json(out);
  });

  return app;
}
