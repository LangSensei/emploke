import type { Catalog } from "@emploke/catalog";
import type { Context, Hono as HonoType } from "hono";

/**
 * Pulls the per-workspace `Catalog` off the Hono request context. Set up
 * by the workspace middleware (see `workspaceCatalogContextMiddleware`
 * in server `index.ts`).
 *
 * Tests can pass a `Catalog` directly instead of going through the
 * middleware chain — every `*Routes` factory accepts either form via
 * `resolveCatalog`.
 */
export type CatalogResolver = (c: Context) => Catalog;

/**
 * Normalise the two accepted argument shapes (`Catalog` instance or
 * `CatalogResolver`) into a single resolver function. Tests typically
 * pass a `Catalog` directly; production wires up a function that reads
 * `c.get("catalog")`.
 */
export function resolveCatalog(arg: CatalogResolver | Catalog): CatalogResolver {
  return typeof arg === "function" ? (arg as CatalogResolver) : () => arg;
}

/** Convenience: chain a catalog resolver into a route mount. */
export type CatalogHonoFactory = (arg: CatalogResolver | Catalog) => HonoType;
