import type { Container } from "inversify";

/**
 * Register this package's bindings into the root inversify container.
 *
 * Phase 0 (issue #135): intentionally empty. The composition root
 * (`@emploke/server`, `@emploke/cli`) calls every package's `compose…
 * Module` at startup so future phases can fill in repositories,
 * queries, command handlers, and notification handlers without
 * touching the bootstrap wiring. No existing class is `@injectable()`
 * yet, and no production code path resolves through the container.
 */
export function composeCatalogModule(_container: Container): void {
  // Phase 0 foundation only — populated in subsequent phases.
}
