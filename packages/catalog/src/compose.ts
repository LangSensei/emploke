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
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db: Db = drizzle(sqlite, { schema });
  runPendingMigrations(sqlite);

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
