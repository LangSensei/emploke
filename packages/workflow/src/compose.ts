import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { applyWorkflowMigrations } from "./migrations.js";
import * as schema from "./schema.js";
import type { TaskDispatcher } from "./types.js";
import { WorkflowRepository } from "./workflow-repository.js";
import { WorkflowService } from "./workflow-service.js";

type Db = BetterSQLite3Database<typeof schema>;

export type WorkflowModuleOptions = (
  | { readonly db: Db; readonly dbFile?: never }
  | { readonly dbFile: string; readonly db?: never }
) & {
  readonly taskDispatcher: TaskDispatcher;
  readonly logger?: Logger;
  readonly now?: () => Date;
};

export interface WorkflowModule {
  readonly service: WorkflowService;
  close(): Promise<void>;
}

/**
 * Single composition entry point. Production callers pass `dbFile`
 * (the pkg opens its own better-sqlite3 connection in WAL mode and
 * runs pending migrations); tests pass an existing `db` from
 * `openTestWorkflowDb()`.
 *
 * `taskDispatcher` is required — `launchNode` dispatches the backing
 * task via this interface. In production it's wired to
 * `@emploke/task`'s `TaskService`; in tests it's a stub that just
 * returns a deterministic id.
 */
export async function composeWorkflowModule(opts: WorkflowModuleOptions): Promise<WorkflowModule> {
  let sqlite: BetterSqliteDatabase | null = null;
  let db: Db;
  if ("db" in opts && opts.db !== undefined) {
    db = opts.db;
  } else {
    sqlite = new Database(opts.dbFile as string);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("busy_timeout = 5000");
    db = drizzle(sqlite, { schema });
    try {
      applyWorkflowMigrations(db);
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }
  const repo = new WorkflowRepository({
    db,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const service = new WorkflowService({
    repo,
    taskDispatcher: opts.taskDispatcher,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return {
    service,
    async close() {
      sqlite?.close();
    },
  };
}
