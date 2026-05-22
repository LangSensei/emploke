import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { buildCatalogRuntime, CatalogService } from "./facade/catalog-service.js";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface CatalogModuleOptions {
  readonly dbFile: string;
  readonly logger?: Logger;
}

export interface CatalogModule {
  readonly service: CatalogService;
  close(): Promise<void>;
}

export async function composeCatalogModule(opts: CatalogModuleOptions): Promise<CatalogModule> {
  const sqlite: BetterSqliteDatabase = new Database(opts.dbFile);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  // No `foreign_keys = ON` — the catalog schema has no FK
  // constraints (the per-pkg migration framework that used to
  // declare them was dropped in #148; reverse-dep safety on uninstall
  // is enforced by an in-repo `count()`-then-throw inside the same
  // transaction as the delete, see `*Repository.delete`). The
  // pragma without FKs is a no-op, but keeping it would mislead
  // future contributors into thinking FKs are honoured.
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

  const rt = buildCatalogRuntime({
    db,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const service = new CatalogService(rt);
  return {
    service,
    async close() {
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
