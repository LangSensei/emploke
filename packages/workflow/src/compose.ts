/**
 * `composeWorkflowModule` is the production composition entrypoint
 * for `@emploke/workflow`: open the DB, run migrations, wire the
 * repository + service + kind-handler registry hooks.
 *
 * Production callers pass `dbFile` (the pkg opens its own
 * better-sqlite3 connection in WAL mode and runs pending migrations);
 * tests pass an existing `db` from `openTestWorkflowDb()`.
 *
 * Callers register every node kind they need via
 * {@link WorkflowService.registerKind} BEFORE calling
 * {@link WorkflowService.recover}. `recover()` freezes the registry
 * and preflights every persisted row's `kind` against it, throwing
 * if any are unregistered.
 */

import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { applyWorkflowMigrations } from "./migrations.js";
import * as schema from "./schema.js";
import { WorkflowRepository } from "./workflow-repository.js";
import { WorkflowService } from "./workflow-service.js";

type Db = BetterSQLite3Database<typeof schema>;

export type WorkflowModuleOptions = (
  | { readonly db: Db; readonly dbFile?: never }
  | { readonly dbFile: string; readonly db?: never }
) & {
  readonly workspaceDir: string;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
};

export interface WorkflowModule {
  readonly service: WorkflowService;
  close(): Promise<void>;
}

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
  const repo = new WorkflowRepository({ db });
  const service = new WorkflowService({
    repo,
    db,
    workspaceDir: opts.workspaceDir,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.randomUUID !== undefined ? { randomUUID: opts.randomUUID } : {}),
  });
  return {
    service,
    async close() {
      sqlite?.close();
    },
  };
}
