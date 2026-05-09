import type { ListSessionStateOpts, SessionRepository, SessionState } from "./repository.js";

/**
 * In-memory implementation of `SessionRepository`. Useful for unit
 * tests that want to skip filesystem orchestration. Storage is plain
 * `Map<id, SessionState>`; no cross-process coordination
 * (single-process by definition).
 */
export class InMemorySessionRepository implements SessionRepository {
  private readonly entries = new Map<string, SessionState>();

  /** Pre-seed the repository with sessions. Useful for test fixtures. */
  constructor(seed: readonly { id: string; state: SessionState }[] = []) {
    for (const e of seed) {
      this.entries.set(e.id, Object.freeze({ ...e.state }));
    }
  }

  async read(id: string): Promise<SessionState | null> {
    return this.entries.get(id) ?? null;
  }

  async save(id: string, state: SessionState): Promise<void> {
    this.entries.set(id, Object.freeze({ ...state }));
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async list(opts: ListSessionStateOpts = {}): Promise<{ id: string; state: SessionState }[]> {
    const out: { id: string; state: SessionState }[] = [];
    for (const [id, state] of this.entries) {
      if (opts.createdSince !== undefined && state.createdAt < opts.createdSince) continue;
      out.push({ id, state });
    }
    return out;
  }
}
