import { MikroORM } from "@mikro-orm/better-sqlite";
import type { EntityManager, MikroORM as IMikroORM } from "@mikro-orm/core";
import type { Logger } from "@emploke/logger";
import type { FetcherRegistry } from "@emploke/catalog-fetcher";
import { CATALOG_ENTITIES } from "./entity.js";
import { CatalogManager } from "./facade/catalog-manager.js";

export type CatalogModuleOptions = (
  | { readonly orm: IMikroORM; readonly dbFile?: never }
  | { readonly dbFile: string; readonly orm?: never }
) & {
  readonly fetchers?: FetcherRegistry;
  readonly logger?: Logger;
};

export interface CatalogModule {
  readonly manager: CatalogManager;
  close(): Promise<void>;
}

export async function composeCatalogModule(opts: CatalogModuleOptions): Promise<CatalogModule> {
  const ownsOrm = opts.orm === undefined;
  const orm =
    opts.orm ??
    (await MikroORM.init({
      entities: [...CATALOG_ENTITIES],
      dbName: opts.dbFile as string,
    }));
  if (ownsOrm) {
    await orm.schema.updateSchema({ safe: true });
  }
  const manager = await CatalogManager.open({
    em: orm.em as EntityManager,
    ...(opts.fetchers !== undefined ? { fetchers: opts.fetchers } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
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
