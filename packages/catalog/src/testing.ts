import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Open an in-memory Drizzle-wrapped better-sqlite3 instance for tests
 * with the catalog schema pre-applied.
 */
export function openTestCatalogDb(): {
  db: Db;
  sqlite: BetterSqliteDatabase;
  close(): void;
} {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  const dir = path.join(import.meta.dirname, "..", "drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  }
  return {
    db,
    sqlite,
    close() {
      sqlite.close();
    },
  };
}
