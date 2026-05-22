import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { buildCatalogRuntime, CatalogService } from "./facade/catalog-service.js";
import { applyCatalogMigrations } from "./migrations.js";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface CatalogModuleOptions {
  readonly dbFile: string;
  readonly logger?: Logger;
}

export interface CatalogModule {
  readonly service: CatalogService;
  close(): Promise<void>;
}

export async function composeCatalogModule(opts: CatalogModuleOptions): Promise<CatalogModule> {
  const sqlite: BetterSqliteDatabase = new Database(opts.dbFile);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  // No `foreign_keys = ON` — the catalog schema has no FK
  // constraints (the per-pkg migration framework that used to
  // declare them was dropped in #148; reverse-dep safety on uninstall
  // is enforced by an in-repo `count()`-then-throw inside the same
  // transaction as the delete, see `*Repository.delete`). The
  // pragma without FKs is a no-op, but keeping it would mislead
  // future contributors into thinking FKs are honoured.
  sqlite.pragma("busy_timeout = 5000");
  const db: Db = drizzle(sqlite, { schema });
  // Migration failure must close the SQLite handle before propagating:
  // a leaked handle would hold the WAL lock and break a subsequent
  // retry from the same caller (EBUSY on the lockfile / WAL files
  // until process exit). Pattern mirrored in every entity pkg.
  try {
    applyCatalogMigrations(db);
  } catch (err) {
    sqlite.close();
    throw err;
  }

  const rt = buildCatalogRuntime({
    db,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const service = new CatalogService(rt);
  return {
    service,
    async close() {
      sqlite.close();
    },
  };
}
