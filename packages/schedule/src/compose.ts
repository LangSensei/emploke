import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { applyScheduleMigrations } from "./migrations.js";
import { ScheduleRepository } from "./schedule-repository.js";
import { ScheduleService } from "./schedule-service.js";
import * as schema from "./schema.js";
import type { TaskDispatcher } from "./types.js";

type Db = BetterSQLite3Database<typeof schema>;

export type ScheduleModuleOptions = (
  | { readonly db: Db; readonly dbFile?: never }
  | { readonly dbFile: string; readonly db?: never }
) & {
  readonly taskDispatcher: TaskDispatcher;
  readonly agentValidator: (fqn: string) => Promise<void>;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
};

export interface ScheduleModule {
  readonly service: ScheduleService;
  close(): Promise<void>;
}

/**
 * Single composition entry point. Production callers pass `dbFile`
 * (the pkg opens its own better-sqlite3 connection in WAL mode and
 * runs pending migrations); tests pass an existing `db` from
 * `openTestScheduleDb()`.
 *
 * `taskDispatcher` and `agentValidator` are required capabilities —
 * the schedule pkg never imports `@emploke/task` or `@emploke/catalog`
 * directly. In production they're adapted in PR 3 from
 * `TaskService.dispatch` + `TaskService.hasInFlightForSchedule` and
 * `CatalogService.getAgentFqn`. In tests they're stubs.
 *
 * `close()` calls `service.shutdown()` BEFORE the SQLite handle is
 * released — the in-flight setTimeout callback would otherwise hit a
 * closed db on wake.
 */
export async function composeScheduleModule(opts: ScheduleModuleOptions): Promise<ScheduleModule> {
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
    // Migration failure must close the SQLite handle before propagating:
    // a leaked handle would hold the WAL lock and break a subsequent
    // retry from the same caller (EBUSY on the lockfile / WAL files
    // until process exit).
    try {
      applyScheduleMigrations(db);
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }
  const repo = new ScheduleRepository({
    db,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const service = new ScheduleService({
    repo,
    taskDispatcher: opts.taskDispatcher,
    agentValidator: opts.agentValidator,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.randomUUID !== undefined ? { randomUUID: opts.randomUUID } : {}),
  });
  return {
    service,
    async close() {
      await service.shutdown();
      sqlite?.close();
    },
  };
}
