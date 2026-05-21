import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Logger } from "@emploke/logger";
import { WorkspaceQueries } from "./queries.js";
import { WorkspaceRepository } from "./repository.js";
import * as schema from "./schema.js";
import { WorkspaceService } from "./service.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Either supply `dbFile` (the composer opens better-sqlite3 + runs
 * pending migrations) or `db` (the caller passes a pre-built Drizzle
 * instance — typical for tests sharing an in-memory connection).
 */
export type WorkspaceModuleOptions = (
  | { readonly dbFile: string }
  | { readonly db: Db }
) & {
  readonly logger?: Logger;
};

export interface WorkspaceModule {
  readonly service: WorkspaceService;
  readonly queries: WorkspaceQueries;
  /** Closes the underlying connection when the composer opened it. */
  close(): Promise<void>;
}

export async function composeWorkspaceModule(
  options: WorkspaceModuleOptions,
): Promise<WorkspaceModule> {
  let sqlite: BetterSqliteDatabase | null = null;
  let db: Db;
  if ("db" in options) {
    db = options.db;
  } else {
    sqlite = new Database(options.dbFile);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    db = drizzle(sqlite, { schema });
    runPendingMigrations(sqlite);
  }

  const repo = new WorkspaceRepository(db);
  const queries = new WorkspaceQueries(db);
  const service = new WorkspaceService(repo, options.logger);

  return {
    service,
    queries,
    async close() {
      sqlite?.close();
    },
  };
}

/**
 * Tiny built-in migrator. drizzle-kit generates SQL files under
 * `drizzle/`; we apply each one once, recording applied filenames in
 * `__drizzle_migrations`. Avoids a runtime dep on
 * `drizzle-orm/better-sqlite3/migrator` and its esbuild-unfriendly
 * `import.meta.url` resolution.
 *
 * Statement splitting: drizzle-kit inserts `--> statement-breakpoint`
 * comments between independent statements. better-sqlite3's `exec()`
 * accepts multi-statement SQL, so we pass the file contents verbatim.
 */
function runPendingMigrations(sqlite: BetterSqliteDatabase): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
  );
  const dir = migrationsDir();
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    return; // no migrations dir yet
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

function migrationsDir(): string {
  return path.join(import.meta.dirname, "..", "drizzle");
}
