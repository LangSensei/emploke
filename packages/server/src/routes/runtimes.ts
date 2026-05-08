import type { RuntimeRegistry } from "@emploke/runtime";
import { Hono } from "hono";

/**
 * Routes for /api/runtimes — exposes the registered runtime kinds so the
 * dashboard can render a runtime picker. Mounted in `index.ts` at "/api/runtimes".
 *
 * Today the registry only has "copilot"; future runtimes (gemini, claude-code,
 * etc.) will surface here automatically once they're registered server-side.
 */
export function runtimesRoutes(registry: RuntimeRegistry): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(registry.kinds()));

  return app;
}
