import { MikroORM } from "@mikro-orm/better-sqlite";
import { TASK_ENTITIES } from "./entity.js";

export { Task } from "./task-entity.js";
export { TaskRow, TASK_ENTITIES } from "./entity.js";
export { TaskRepository } from "./repository.js";
export { TaskManager } from "./manager.js";
export { composeTaskModule } from "./compose.js";

export async function openTestTaskOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init({
    entities: [...TASK_ENTITIES],
    dbName: ":memory:",
    allowGlobalContext: true,
  });
  await orm.schema.createSchema();
  return orm;
}
