import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { __Entity__Repository } from "./__entity-kebab__-repository.js";
import { __Entity__Service } from "./__entity-kebab__-service.js";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export type __Entity__ModuleOptions = (
  | { readonly db: Db; readonly dbFile?: never }
  | { readonly dbFile: string; readonly db?: never }
) & {
  readonly logger?: Logger;
  readonly now?: () => Date;
};

export interface __Entity__Module {
  readonly service: __Entity__Service;
  close(): Promise<void>;
}

/**
 * Single composition entry point. Production callers pass `dbFile`
 * (the pkg opens its own better-sqlite3 connection in WAL mode and
 * runs pending migrations); tests pass an existing `db` from
 * `openTest__Entity__Db()`.
 */
export async function compose__Entity__Module(
  opts: __Entity__ModuleOptions,
): Promise<__Entity__Module> {
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
    // Migration failure must close the SQLite handle before propagating:
    // a leaked handle would hold the WAL lock and break a subsequent
    // retry from the same caller (EBUSY on the lockfile / WAL files
    // until process exit).
    try {
      runPendingMigrations(sqlite);
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }
  const repo = new __Entity__Repository({
    db,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const service = new __Entity__Service(repo, opts.now !== undefined ? { now: opts.now } : {});
  return {
    service,
    async close() {
      sqlite?.close();
    },
  };
}

/**
 * Replay `drizzle/*.sql` files lexicographically against the given
 * sqlite connection, tracking applied names in `__drizzle_migrations`.
 *
 * Hand-rolled to avoid drizzle's built-in `migrator` which has
 * `import.meta.url` resolution issues with esbuild bundles.
 */
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
