import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import * as schema from "./schema.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { WorkspaceService } from "./workspace-service.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Open a better-sqlite3 connection in WAL mode, run pending migrations,
 * and wire up `WorkspaceService`. Tests pass `dbFile: ":memory:"`;
 * production passes the absolute path to `global.db`.
 */
export interface WorkspaceModuleOptions {
  readonly dbFile: string;
  readonly logger?: Logger;
}

export interface WorkspaceModule {
  readonly service: WorkspaceService;
  /** Closes the underlying connection. */
  close(): Promise<void>;
}

export async function composeWorkspaceModule(
  options: WorkspaceModuleOptions,
): Promise<WorkspaceModule> {
  const sqlite: BetterSqliteDatabase = new Database(options.dbFile);
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

  const repo = new WorkspaceRepository({ db });
  const service = new WorkspaceService(repo, db, options.logger);

  return {
    service,
    async close() {
      sqlite.close();
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
  // Apply each migration in a single transaction so a partial failure
  // (a syntactically invalid statement late in the file) rolls back the
  // whole file. Without this the schema could land half-applied with no
  // matching journal row and the next boot would re-run the same file
  // from the top and crash on duplicate-table.
  const applyOne = sqlite.transaction((name: string) => {
    const sql = readFileSync(path.join(dir, name), "utf8");
    sqlite.exec(sql);
    insertApplied.run(name, new Date().toISOString());
  });
  for (const name of files) {
    if (applied.has(name)) continue;
    applyOne(name);
  }
}

function migrationsDir(): string {
  return path.join(import.meta.dirname, "..", "drizzle");
}
