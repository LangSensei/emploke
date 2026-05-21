import { MikroORM } from "@mikro-orm/better-sqlite";
import type { EntityManager, MikroORM as IMikroORM } from "@mikro-orm/core";
import type { CatalogManager } from "@emploke/catalog";
import type { Logger } from "@emploke/logger";
import type { RuntimeRegistry } from "@emploke/runtime";
import { TASK_ENTITIES } from "./entity.js";
import { TaskManager } from "./manager.js";

export type TaskModuleOptions = (
  | { readonly orm: IMikroORM; readonly dbFile?: never }
  | { readonly dbFile: string; readonly orm?: never }
) & {
  readonly catalog: CatalogManager;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly tasksDir: string;
  readonly workspaceDir: string;
  readonly workspaceId?: string;
  readonly subprocessEnv?: NodeJS.ProcessEnv;
  readonly defaultRuntime?: string;
  readonly logger?: Logger;
};

export interface TaskModule {
  readonly manager: TaskManager;
  close(): Promise<void>;
}

export async function composeTaskModule(opts: TaskModuleOptions): Promise<TaskModule> {
  const ownsOrm = opts.orm === undefined;
  const orm =
    opts.orm ??
    (await MikroORM.init({
      entities: [...TASK_ENTITIES],
      dbName: opts.dbFile as string,
    }));
  if (ownsOrm) {
    await orm.schema.updateSchema({ safe: true });
  }

  const manager = new TaskManager({
    catalog: opts.catalog,
    runtimeRegistry: opts.runtimeRegistry,
    tasksDir: opts.tasksDir,
    workspaceDir: opts.workspaceDir,
    ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.subprocessEnv !== undefined ? { subprocessEnv: opts.subprocessEnv } : {}),
    ...(opts.defaultRuntime !== undefined ? { defaultRuntime: opts.defaultRuntime } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    em: orm.em as EntityManager,
  });

  return {
    manager,
    async close() {
      manager.close();
      if (ownsOrm) {
        await orm.close(true);
      }
    },
  };
}
