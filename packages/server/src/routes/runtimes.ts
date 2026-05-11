import type { RuntimeRegistry } from "@emploke/runtime";
import { Hono } from "hono";

/**
 * Routes for /api/runtimes — exposes the registered runtime kinds AND
 * each runtime's advertised capability flags so the dashboard / future
 * CLI can conditionally enable UI affordances (e.g. a "Spawn remote"
 * button only renders enabled when the active runtime sets
 * `capabilities.remoteSession === true`).
 *
 * Wire shape: `[{ kind: string, capabilities: object }]`. Capabilities
 * are pass-through from the `Runtime.capabilities` field; an empty
 * object `{}` means the runtime made no opt-in claims (the absence of
 * a flag === unsupported, not unknown).
 *
 * The previous wire shape was a bare `string[]` of kinds. Bumping to
 * an object array is a breaking change for the dashboard but kept the
 * additive surface honest — clients that only needed kind names map
 * `.map(r => r.kind)` once at the api boundary.
 */
export interface RuntimeInfo {
  readonly kind: string;
  readonly capabilities: Record<string, unknown>;
}

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
