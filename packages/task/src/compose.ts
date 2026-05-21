import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { CatalogManager } from "@emploke/catalog";
import type { Logger } from "@emploke/logger";
import type { RuntimeRegistry } from "@emploke/runtime";
import { TaskManager } from "./manager.js";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export type TaskModuleOptions = (
  | { readonly db: Db; readonly dbFile?: never }
  | { readonly dbFile: string; readonly db?: never }
) & {
  readonly catalog: CatalogManager;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly tasksDir: string;
  readonly workspaceDir: string;
  readonly workspaceId?: string;
  readonly subprocessEnv?: NodeJS.ProcessEnv;
  readonly defaultRuntime?: string;
  readonly logger?: Logger;
};

export interface TaskModule {
  readonly manager: TaskManager;
  close(): Promise<void>;
}

export async function composeTaskModule(opts: TaskModuleOptions): Promise<TaskModule> {
  let sqlite: BetterSqliteDatabase | null = null;
  let db: Db;
  if ("db" in opts && opts.db !== undefined) {
    db = opts.db;
  } else {
    sqlite = new Database(opts.dbFile as string);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    db = drizzle(sqlite, { schema });
    runPendingMigrations(sqlite);
  }

  const manager = new TaskManager({
    catalog: opts.catalog,
    runtimeRegistry: opts.runtimeRegistry,
    tasksDir: opts.tasksDir,
    workspaceDir: opts.workspaceDir,
    ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.subprocessEnv !== undefined ? { subprocessEnv: opts.subprocessEnv } : {}),
    ...(opts.defaultRuntime !== undefined ? { defaultRuntime: opts.defaultRuntime } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    db,
  });

  return {
    manager,
    async close() {
      manager.close();
      sqlite?.close();
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
    files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
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
