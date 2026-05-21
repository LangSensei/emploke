import { type SQL, and, eq, gte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { type Logger, silentLogger } from "@emploke/logger";
import { InvalidSessionIdError } from "./errors.js";
import { SESSION_ID_RE } from "./validate.js";
import { type Session, sessions } from "./schema.js";
import type * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface ListSessionStateOpts {
  readonly createdSince?: string;
  readonly agent?: string;
}

/**
 * Drizzle-backed CRUD for the `sessions` table. Defense-in-depth: every
 * public method validates `id` against `SESSION_ID_RE` before reaching
 * the DB. The validation keeps the "sessions namespace, not arbitrary
 * keys" contract explicit.
 */
export class SessionRepository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
    void this.logger;
  }

  async read(id: string): Promise<Session | undefined> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  async insert(row: {
    id: string;
    agent: string;
    runtime: string;
    createdAt: string;
    runtimeSessionId: string | null;
    lastLaunchMode?: "local" | "remote" | null;
  }): Promise<void> {
    if (!SESSION_ID_RE.test(row.id)) throw new InvalidSessionIdError(row.id);
    this.db
      .insert(sessions)
      .values({
        id: row.id,
        agent: row.agent,
        runtime: row.runtime,
        createdAt: row.createdAt,
        runtimeSessionId: row.runtimeSessionId,
        lastLaunchMode: row.lastLaunchMode ?? null,
      })
      .run();
  }

  /** Atomically update only the `lastLaunchMode` column. */
  async patchLastLaunchMode(id: string, mode: "local" | "remote"): Promise<void> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    this.db.update(sessions).set({ lastLaunchMode: mode }).where(eq(sessions.id, id)).run();
  }

  /** Idempotent delete. */
  async delete(id: string): Promise<void> {
    if (!SESSION_ID_RE.test(id)) return;
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
  }

  async list(opts: ListSessionStateOpts = {}): Promise<Session[]> {
    const filters: SQL[] = [];
    if (opts.createdSince !== undefined) filters.push(gte(sessions.createdAt, opts.createdSince));
    if (opts.agent !== undefined) filters.push(eq(sessions.agent, opts.agent));
    const query = this.db.select().from(sessions);
    return filters.length > 0 ? query.where(and(...filters)).all() : query.all();
  }
}
