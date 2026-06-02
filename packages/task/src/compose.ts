import type { AgentContentSource, RuntimeRegistry } from "@emploke/runtime";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { applyTaskMigrations } from "./migrations.js";
import type { AgentResolverPort } from "./ports.js";
import * as schema from "./schema.js";
import { TaskService } from "./task-service.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface TaskModuleOptions {
  readonly dbFile: string;
  readonly agentResolver: AgentResolverPort;
  readonly contentSource: AgentContentSource;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly workspaceDir: string;
  readonly workspaceId: string;
  readonly logger?: Logger;
}

export interface TaskModule {
  readonly service: TaskService;
  close(): Promise<void>;
}

export async function composeTaskModule(opts: TaskModuleOptions): Promise<TaskModule> {
  const sqlite: BetterSqliteDatabase = new Database(opts.dbFile);
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
    applyTaskMigrations(db);
  } catch (err) {
    sqlite.close();
    throw err;
  }

  const service = new TaskService({
    agentResolver: opts.agentResolver,
    contentSource: opts.contentSource,
    runtimeRegistry: opts.runtimeRegistry,
    workspaceDir: opts.workspaceDir,
    workspaceId: opts.workspaceId,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    db,
  });

  return {
    service,
    async close() {
      service.close();
      sqlite.close();
    },
  };
}
