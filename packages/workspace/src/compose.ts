import type { Logger } from "@emploke/logger";
import { defineConfig } from "@mikro-orm/better-sqlite";
import { type EntityManager, MikroORM } from "@mikro-orm/core";
import { WORKSPACE_ENTITIES } from "./entity.js";
import { WorkspaceQueries } from "./queries.js";
import { WorkspaceRepository } from "./repository.js";
import { WorkspaceService } from "./service.js";

/**
 * Configuration for {@link composeWorkspaceModule}.
 *
 * Either supply `dbFile` (the composer opens the MikroORM instance,
 * runs `updateSchema`, and owns its lifecycle) or `orm` (the caller
 * — typically tests — passes a pre-built instance). The two are
 * mutually exclusive.
 */
export type WorkspaceModuleOptions = (
  | {
      readonly dbFile: string;
      /** Skip `orm.schema.updateSchema()` after init. Defaults to `true`. */
      readonly updateSchema?: boolean;
      /** Forwarded to MikroORM. Defaults to `true` to match prior behaviour. */
      readonly allowGlobalContext?: boolean;
    }
  | { readonly orm: MikroORM }
) & {
  readonly logger?: Logger;
};

/**
 * Plain handle returned by {@link composeWorkspaceModule}. Holds the
 * single instances callers wire into their own composition root.
 *
 * `close()` shuts down the MikroORM instance — but only when the
 * composer owned it. When the caller passed `{ orm }`, `close()` is a
 * no-op so we don't yank the rug out from under code that still
 * holds a reference.
 */
export interface WorkspaceModule {
  readonly service: WorkspaceService;
  readonly queries: WorkspaceQueries;
  close(): Promise<void>;
}

/**
 * Build the workspace module: open / accept a MikroORM instance,
 * construct the repository / queries / service against it, return
 * them on a single handle.
 *
 * No container, no mediator. Callers wire `module.service` /
 * `module.queries` into their own composition root however they like.
 */
export async function composeWorkspaceModule(
  options: WorkspaceModuleOptions,
): Promise<WorkspaceModule> {
  const ownsOrm = !("orm" in options);
  let orm: MikroORM;
  if ("orm" in options) {
    orm = options.orm;
  } else {
    orm = await MikroORM.init(
      defineConfig({
        entities: [...WORKSPACE_ENTITIES],
        dbName: options.dbFile,
        allowGlobalContext: options.allowGlobalContext ?? true,
      }),
    );
    if (options.updateSchema !== false) {
      await orm.schema.updateSchema();
    }
  }

  const em = orm.em as EntityManager;
  const repo = new WorkspaceRepository(em);
  const queries = new WorkspaceQueries(em);
  const service = new WorkspaceService(repo, em, options.logger);

  return {
    service,
    queries,
    async close() {
      if (ownsOrm) {
        await orm.close(true);
      }
    },
  };
}
