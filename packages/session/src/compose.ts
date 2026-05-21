import type { EntityManager, MikroORM as IMikroORM } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/better-sqlite";
import type { CatalogManager } from "@emploke/catalog";
import type { Logger } from "@emploke/logger";
import type { RuntimeRegistry } from "@emploke/runtime";
import { SESSION_ENTITIES } from "./entity.js";
import { SessionManager } from "./manager.js";

/**
 * Options for `composeSessionModule`. Either `orm` (caller owns the
 * lifecycle) or `dbFile` (the compose function opens + owns the ORM).
 */
export type SessionModuleOptions = (
  | { readonly orm: IMikroORM; readonly dbFile?: never }
  | { readonly dbFile: string; readonly orm?: never }
) & {
  readonly catalog: CatalogManager;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly sessionsDir: string;
  readonly workspaceDir: string;
  readonly workspaceId?: string;
  readonly subprocessEnv?: NodeJS.ProcessEnv;
  readonly defaultRuntime?: string;
  readonly logger?: Logger;
};

export interface SessionModule {
  readonly manager: SessionManager;
  /**
   * Releases the ORM if compose opened it (i.e. `dbFile` was passed).
   * No-op when the caller passed their own `orm`. Idempotent.
   */
  close(): Promise<void>;
}

/**
 * Construct a `SessionManager` wired against a MikroORM `EntityManager`.
 *
 * Two modes:
 *   - `{ orm }`: caller owns the ORM lifecycle (typical for tests and
 *     for the @emploke/core orchestrator which keeps the ORM open for
 *     the workspace's lifetime).
 *   - `{ dbFile }`: compose opens the ORM internally and `close()`
 *     shuts it down. Used by ad-hoc consumers.
 */
export async function composeSessionModule(opts: SessionModuleOptions): Promise<SessionModule> {
  const ownsOrm = opts.orm === undefined;
  const orm =
    opts.orm ??
    (await MikroORM.init({
      entities: [...SESSION_ENTITIES],
      dbName: opts.dbFile as string,
    }));
  if (ownsOrm) {
    await orm.schema.updateSchema({ safe: true });
  }

  const manager = new SessionManager({
    catalog: opts.catalog,
    runtimeRegistry: opts.runtimeRegistry,
    sessionsDir: opts.sessionsDir,
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
      if (ownsOrm) {
        await orm.close(true);
      }
    },
  };
}
