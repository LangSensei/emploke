import { openTestCatalogDb } from "../../src/testing.js";

export { openTestCatalogDb };

/**
 * Bootstrap helper for catalog tests. Opens an in-memory Drizzle
 * (better-sqlite3) instance with the catalog schema pre-applied.
 * Callers should call `handle.close()` in afterEach.
 */
export function bootstrapCatalogDb(): ReturnType<typeof openTestCatalogDb> {
  return openTestCatalogDb();
}
