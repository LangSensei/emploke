import type { CatalogService } from "@emploke/catalog";
import type { Context, Hono as HonoType } from "hono";

/**
 * Pulls the per-workspace `CatalogService` off the Hono request context.
 * Set up by the workspace middleware (see `workspaceContextMiddleware`
 * in server `index.ts`).
 *
 * Tests can pass a `CatalogService` directly instead of going through
 * the middleware chain — every `*Routes` factory accepts either form
 * via `resolveCatalog`.
 */
export type CatalogResolver = (c: Context) => CatalogService;

export function resolveCatalog(arg: CatalogResolver | CatalogService): CatalogResolver {
  return typeof arg === "function" ? (arg as CatalogResolver) : () => arg;
}

export type CatalogHonoFactory = (arg: CatalogResolver | CatalogService) => HonoType;
