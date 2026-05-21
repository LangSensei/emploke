import type { MikroORM } from "@mikro-orm/core";
import { openTestCatalogOrm } from "../../src/testing.js";

export { openTestCatalogOrm };

/**
 * Bootstrap helper for catalog tests post-de-DDD.
 *
 * Replaces the old `bootstrapCatalogDb(db: DatabaseSync)` which ran
 * the custom migration coordinator over a raw `node:sqlite` handle.
 * Now opens an in-memory MikroORM instance with the catalog entities
 * and creates the schema. Callers should `await orm.close(true)` in
 * afterEach.
 */
export async function bootstrapCatalogOrm(): Promise<MikroORM> {
  return openTestCatalogOrm();
}
