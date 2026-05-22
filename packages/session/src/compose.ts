import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CatalogService } from "@emploke/catalog";
import type { RuntimeRegistry } from "@emploke/runtime";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import * as schema from "./schema.js";
import { SessionService } from "./session-service.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface SessionModuleOptions {
  readonly dbFile: string;
  readonly catalog: CatalogService;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly workspaceDir: string;
  readonly workspaceId: string;
  readonly logger?: Logger;
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
    runPendingMigrations(sqlite);
  } catch (err) {
    sqlite.close();
    throw err;
  }

  const service = new SessionService({
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
      sqlite.close();
    },
  };
}

/**
 * Minimal in-house migration runner: applies any `*.sql` files in
 * `drizzle/` that haven't been recorded in `__drizzle_migrations` yet.
 *
 * We hand-roll this instead of using `drizzle-orm/better-sqlite3/migrator`
 * because that helper expects to read a sibling `meta/_journal.json` plus
 * per-migration snapshot files relative to a packaged path that breaks
 * when the pkg is installed under `node_modules/.pnpm/...`. Re-implementing
 * the "apply unseen files in lexical order" loop directly keeps the
 * runtime path dependency-free (only `better-sqlite3` + `fs`) and matches
 * the same pattern used by every other emploke pkg's `compose.ts`.
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
