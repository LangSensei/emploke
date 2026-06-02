import type { AgentContentSource, RuntimeRegistry } from "@emploke/runtime";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { applySessionMigrations } from "./migrations.js";
import type { AgentResolverPort } from "./ports.js";
import * as schema from "./schema.js";
import { SessionService } from "./session-service.js";
import type { SpawnFn } from "./types.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface SessionModuleOptions {
  readonly dbFile: string;
  readonly agentResolver: AgentResolverPort;
  readonly contentSource: AgentContentSource;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly workspaceDir: string;
  readonly workspaceId: string;
  readonly logger?: Logger;
  /**
   * Terminal spawner. Wired by `@emploke/api`'s composition root
   * (`spawnTerminal` from `@emploke/terminal` by default; tests may
   * inject a fake). Optional so that test setups that don't exercise
   * spawn can omit it; in production every caller threads it
   * through.
   */
  readonly spawnFn?: SpawnFn;
}

export interface SessionModule {
  readonly service: SessionService;
  close(): Promise<void>;
}

export async function composeSessionModule(opts: SessionModuleOptions): Promise<SessionModule> {
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
    applySessionMigrations(db);
  } catch (err) {
    sqlite.close();
    throw err;
  }

  const service = new SessionService({
    agentResolver: opts.agentResolver,
    contentSource: opts.contentSource,
    runtimeRegistry: opts.runtimeRegistry,
    workspaceDir: opts.workspaceDir,
    workspaceId: opts.workspaceId,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(opts.spawnFn !== undefined ? { spawnFn: opts.spawnFn } : {}),
    db,
  });

  return {
    service,
    async close() {
      sqlite.close();
    },
  };
}
