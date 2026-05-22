import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { applyWorkspaceMigrations } from "./migrations.js";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Open an in-memory Drizzle-wrapped better-sqlite3 instance for tests
 * with the workspace schema pre-applied. Mirrors `compose.ts` exactly so
 * tests see the same migration path production code creates.
 */
export function openTestWorkspaceDb(): {
  db: Db;
  sqlite: BetterSqliteDatabase;
  close(): void;
} {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  // No `foreign_keys = ON`  schema has no FK constraints; the pragma
  // without FKs is a no-op and would mislead readers.
  const db = drizzle(sqlite, { schema });
  applyWorkspaceMigrations(db);
  return {
    db,
    sqlite,
    close() {
      sqlite.close();
    },
  };
}
