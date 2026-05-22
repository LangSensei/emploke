import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { __Entity__Repository } from "./__entity-kebab__-repository.js";
import { __Entity__Service } from "./__entity-kebab__-service.js";
import { apply__Entity__Migrations } from "./migrations.js";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export type __Entity__ModuleOptions = (
  | { readonly db: Db; readonly dbFile?: never }
  | { readonly dbFile: string; readonly db?: never }
) & {
  readonly logger?: Logger;
  readonly now?: () => Date;
};

export interface __Entity__Module {
  readonly service: __Entity__Service;
  close(): Promise<void>;
}

/**
 * Single composition entry point. Production callers pass `dbFile`
 * (the pkg opens its own better-sqlite3 connection in WAL mode and
 * runs pending migrations); tests pass an existing `db` from
 * `openTest__Entity__Db()`.
 */
export async function compose__Entity__Module(
  opts: __Entity__ModuleOptions,
): Promise<__Entity__Module> {
  let sqlite: BetterSqliteDatabase | null = null;
  let db: Db;
  if ("db" in opts && opts.db !== undefined) {
    db = opts.db;
  } else {
    sqlite = new Database(opts.dbFile as string);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    // No `foreign_keys = ON`  adjust if your schema actually declares FKs.
    sqlite.pragma("busy_timeout = 5000");
    db = drizzle(sqlite, { schema });
    // Migration failure must close the SQLite handle before propagating:
    // a leaked handle would hold the WAL lock and break a subsequent
    // retry from the same caller (EBUSY on the lockfile / WAL files
    // until process exit).
    try {
      apply__Entity__Migrations(db);
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }
  const repo = new __Entity__Repository({
    db,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const service = new __Entity__Service(repo, opts.now !== undefined ? { now: opts.now } : {});
  return {
    service,
    async close() {
      sqlite?.close();
    },
  };
}
