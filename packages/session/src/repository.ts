import type { EntityManager } from "@mikro-orm/core";
import { InvalidSessionIdError } from "./errors.js";
import { SESSION_ID_RE } from "./ids.js";
import { Session } from "./entity.js";

export interface ListSessionStateOpts {
  /**
   * Drop entries whose `createdAt` is strictly before this ISO 8601
   * timestamp. ISO strings sort lexicographically as dates.
   */
  readonly createdSince?: string;
  /**
   * Filter to sessions whose persisted `agent` (FQN) matches this exact
   * value. Indexed by `sessions_agent_idx`.
   */
  readonly agent?: string;
}

/**
 * MikroORM-backed CRUD for the `sessions` table. Plain class — no DI,
 * no interface, no abstract base. `SessionManager` owns one instance
 * via `compose`.
 *
 * Defense-in-depth: every public method validates `id` against
 * `SESSION_ID_RE` before reaching the EM. SQLite parameter binding
 * already makes injection harmless; the validation keeps the
 * "sessions namespace, not arbitrary keys" contract explicit.
 */
export class SessionRepository {
  constructor(private readonly em: EntityManager) {}

  async read(id: string): Promise<Session | null> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    return this.em.findOne(Session, { id });
  }

  /**
   * Insert a fresh row. Caller is responsible for ensuring the id is
   * unused (the manager retries on EEXIST during workdir allocation,
   * so collisions on the row insert are vanishingly unlikely).
   */
  async insert(row: {
    id: string;
    agent: string;
    runtime: string;
    createdAt: string;
    runtimeSessionId: string | null;
    lastLaunchMode?: "local" | "remote" | null;
  }): Promise<Session> {
    if (!SESSION_ID_RE.test(row.id)) throw new InvalidSessionIdError(row.id);
    const session = this.em.create(Session, {
      id: row.id,
      agent: row.agent,
      runtime: row.runtime,
      createdAt: row.createdAt,
      runtimeSessionId: row.runtimeSessionId,
      lastLaunchMode: row.lastLaunchMode ?? null,
    });
    await this.em.persistAndFlush(session);
    return session;
  }

  /**
   * Atomically update only the `lastLaunchMode` column. No-op when the
   * row does not exist (mirrors `delete`'s idempotent semantics).
   */
  async patchLastLaunchMode(id: string, mode: "local" | "remote"): Promise<void> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    await this.em.nativeUpdate(Session, { id }, { lastLaunchMode: mode });
  }

  /**
   * Remove the row. Idempotent: deleting a missing id is a no-op.
   * Does NOT touch agent-owned content under the session's workdir —
   * that concern lives in `SessionManager.delete(id, { purge })`.
   */
  async delete(id: string): Promise<void> {
    if (!SESSION_ID_RE.test(id)) return;
    await this.em.nativeDelete(Session, { id });
  }

  /**
   * Snapshot of every session this repository knows about. Filters
   * apply at the SQL layer.
   */
  async list(opts: ListSessionStateOpts = {}): Promise<Session[]> {
    const where: { createdAt?: { $gte: string }; agent?: string } = {};
    if (opts.createdSince !== undefined) where.createdAt = { $gte: opts.createdSince };
    if (opts.agent !== undefined) where.agent = opts.agent;
    return this.em.find(Session, where);
  }
}
