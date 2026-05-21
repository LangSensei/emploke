import { MikroORM } from "@mikro-orm/better-sqlite";
import { SESSION_ENTITIES } from "./entity.js";

export { Session, SESSION_ENTITIES } from "./entity.js";
export { SessionRepository } from "./repository.js";
export { SessionManager } from "./manager.js";
export { composeSessionModule } from "./compose.js";

/**
 * Open an in-memory MikroORM instance with the session entities
 * registered and the schema created. Convenience for tests.
 */
export async function openTestSessionOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init({
    entities: [...SESSION_ENTITIES],
    dbName: ":memory:",
    allowGlobalContext: true,
  });
  await orm.schema.createSchema();
  return orm;
}
