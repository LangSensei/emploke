import type { CatalogService } from "@emploke/catalog";
import type { RuntimeRegistry } from "@emploke/runtime";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { MIGRATIONS } from "./migrations.generated.js";
import * as schema from "./schema.js";
import { TaskService } from "./task-service.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface TaskModuleOptions {
  readonly dbFile: string;
  readonly catalog: CatalogService;
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
    runPendingMigrations(sqlite);
  } catch (err) {
    sqlite.close();
    throw err;
  }

  const service = new TaskService({
    catalog: opts.catalog,
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

/**
 * In-house migration walker — same rationale as
 * `@emploke/session`'s `compose.ts`. drizzle-kit's bundled migrator
 * cannot resolve its sibling `meta/_journal.json` once the pkg is
 * installed under `node_modules/.pnpm/...`, so each pkg ships its
 * own dependency-free `*.sql` lexical apply loop.
 */
function runPendingMigrations(sqlite: BetterSqliteDatabase): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    sqlite
      .prepare("SELECT name FROM __drizzle_migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );
  const insertApplied = sqlite.prepare(
    "INSERT INTO __drizzle_migrations (name, applied_at) VALUES (?, ?)",
  );
  // Apply each migration in a single transaction so a partial failure
  // (a syntactically invalid statement late in the file) rolls back the
  // whole file. Without this the schema could land half-applied with no
  // matching journal row and the next boot would re-run the same file
  // from the top and crash on duplicate-table.
  const applyOne = sqlite.transaction((name: string, sql: string) => {
    sqlite.exec(sql);
    insertApplied.run(name, new Date().toISOString());
  });
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    applyOne(m.name, m.sql);
  }
}
