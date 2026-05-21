import type { CatalogQueries, CatalogService } from "@emploke/catalog";
import type { Context, Hono as HonoType } from "hono";

/**
 * Bundle of catalog write + read handles passed to route mounts.
 * The split mirrors the catalog package's CQRS-ish boundary:
 *   - `service` exposes mutations (install, update, delete, sync apply)
 *   - `queries` exposes reads (list, get, resolve, find dependents)
 *
 * Routes pick whichever halves they need. Both refer to the same
 * underlying catalog state — writes are visible to subsequent reads
 * with no cache invalidation.
 */
export interface CatalogFacade {
  readonly service: CatalogService;
  readonly queries: CatalogQueries;
}

/**
 * Pulls the per-workspace `CatalogFacade` off the Hono request context.
 * Set up by the workspace middleware (see `workspaceCatalogContextMiddleware`
 * in server `index.ts`).
 *
 * Tests can pass a `CatalogFacade` directly instead of going through the
 * middleware chain — every `*Routes` factory accepts either form via
 * `resolveCatalog`.
 */
export type CatalogResolver = (c: Context) => CatalogFacade;

export function resolveCatalog(arg: CatalogResolver | CatalogFacade): CatalogResolver {
  return typeof arg === "function" ? (arg as CatalogResolver) : () => arg;
}

export type CatalogHonoFactory = (arg: CatalogResolver | CatalogFacade) => HonoType;
