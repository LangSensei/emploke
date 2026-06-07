/**
 * `composeWorkflowModule` is the production composition entrypoint
 * for `@emploke/workflow`: open the DB, run migrations, wire the
 * repository + service with the caller-supplied per-kind runners.
 *
 * Production callers pass `dbFile` (the pkg opens its own
 * better-sqlite3 connection in WAL mode and runs pending migrations);
 * tests pass an existing `db` from `openTestWorkflowDb()`.
 *
 * Runners are injected at compose time via the `runners` field. The
 * `WorkflowRunners` type is `{ coordinator, worker }`; both fields
 * are non-optional so a missing runner is a TypeScript compile error
 * rather than a runtime throw. To add a new kind, extend
 * `NodeKind` and add a matching field on `WorkflowRunners` — the
 * substrate's exhaustive `switch (kind)` branches will fail to
 * compile until every new kind has a runner.
 */

import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { applyWorkflowMigrations } from "./migrations.js";
import * as schema from "./schema.js";
import type { WorkflowRunners } from "./types.js";
import { WorkflowRepository } from "./workflow-repository.js";
import { WorkflowService } from "./workflow-service.js";

type Db = BetterSQLite3Database<typeof schema>;

export type WorkflowModuleOptions = (
  | { readonly db: Db; readonly dbFile?: never }
  | { readonly dbFile: string; readonly db?: never }
) & {
  readonly workspaceDir: string;
  readonly runners: WorkflowRunners;
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
    runners: opts.runners,
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
