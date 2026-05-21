import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";

/** Drizzle handle typed against the catalog schema. */
export type Db = BetterSQLite3Database<typeof schema>;
