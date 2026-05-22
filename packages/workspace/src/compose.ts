import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { applyWorkspaceMigrations } from "./migrations.js";
import * as schema from "./schema.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { WorkspaceService } from "./workspace-service.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Open a better-sqlite3 connection in WAL mode, run pending migrations,
 * and wire up `WorkspaceService`. Tests pass `dbFile: ":memory:"`;
 * production passes the absolute path to `global.db`.
 */
export interface WorkspaceModuleOptions {
  readonly dbFile: string;
  readonly logger?: Logger;
}

export interface WorkspaceModule {
  readonly service: WorkspaceService;
  /** Closes the underlying connection. */
  close(): Promise<void>;
}

export async function composeWorkspaceModule(
  options: WorkspaceModuleOptions,
): Promise<WorkspaceModule> {
  const sqlite: BetterSqliteDatabase = new Database(options.dbFile);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  // No `foreign_keys = ON`  schema has no FK constraints; the
  // pragma without FKs is a no-op and would mislead readers.
  sqlite.pragma("busy_timeout = 5000");
  const db: Db = drizzle(sqlite, { schema });
  // Migration failure must close the SQLite handle before propagating:
  // a leaked handle would hold the WAL lock and break a subsequent
  // retry from the same caller (EBUSY on the lockfile / WAL files
  // until process exit). Pattern mirrored in every entity pkg.
  try {
    applyWorkspaceMigrations(db);
  } catch (err) {
    sqlite.close();
    throw err;
  }

  const repo = new WorkspaceRepository({ db });
  const service = new WorkspaceService(repo, options.logger);

  return {
    service,
    async close() {
      sqlite.close();
    },
  };
}
