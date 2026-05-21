import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CatalogService } from "@emploke/catalog";
import type { RuntimeRegistry } from "@emploke/runtime";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
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
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db: Db = drizzle(sqlite, { schema });
  runPendingMigrations(sqlite);

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

function runPendingMigrations(sqlite: BetterSqliteDatabase): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
  );
  const dir = path.join(import.meta.dirname, "..", "drizzle");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    return;
  }
  const applied = new Set(
    sqlite
      .prepare("SELECT name FROM __drizzle_migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );
  const insertApplied = sqlite.prepare(
    "INSERT INTO __drizzle_migrations (name, applied_at) VALUES (?, ?)",
  );
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(path.join(dir, name), "utf8");
    sqlite.exec(sql);
    insertApplied.run(name, new Date().toISOString());
  }
}
