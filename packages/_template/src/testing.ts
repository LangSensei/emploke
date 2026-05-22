import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Open an in-memory Drizzle-wrapped better-sqlite3 instance for tests
 * with the __PKG__ schema pre-applied. Caller closes via `.close()`.
 *
 * Mirrors the migrator in `compose.ts` so test DBs see the exact same
 * schema production code creates. NOTHING else is re-exported from this
 * module — production callers use the package's `index.ts` barrel.
 */
export function openTest__Entity__Db(): {
  db: Db;
  sqlite: BetterSqliteDatabase;
  close(): void;
} {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  // No `foreign_keys = ON`  schema has no FK constraints; the
  // pragma without FKs is a no-op and would mislead readers.
  const db = drizzle(sqlite, { schema });
  // Apply migrations the same transactional way `compose.ts` does
  // so a partial failure leaves a clean rollback (matters for the
  // rare test that intentionally feeds a malformed migration; on
  // the happy path the transaction wrapper is free).
  const dir = path.join(import.meta.dirname, "..", "drizzle");
  const applyOne = sqlite.transaction((name: string) => {
    sqlite.exec(readFileSync(path.join(dir, name), "utf8"));
  });
  for (const name of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    applyOne(name);
  }
  return {
    db,
    sqlite,
    close() {
      sqlite.close();
    },
  };
}
