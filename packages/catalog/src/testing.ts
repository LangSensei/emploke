import { MikroORM } from "@mikro-orm/better-sqlite";
import { CATALOG_ENTITIES } from "./entity.js";

export { CATALOG_ENTITIES } from "./entity.js";

export async function openTestCatalogOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init({
    entities: [...CATALOG_ENTITIES],
    dbName: ":memory:",
    allowGlobalContext: true,
  });
  await orm.schema.createSchema();
  return orm;
}
