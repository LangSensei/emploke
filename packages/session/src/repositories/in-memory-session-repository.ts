import { assertValidSessionId } from "../ids.js";
import type { ListSessionStateOpts, SessionRepository, SessionState } from "./repository.js";

/**
 * In-memory implementation of `SessionRepository`. Useful for unit
 * tests that want to skip filesystem orchestration. Storage is plain
 * `Map<id, SessionState>`; no cross-process coordination
 * (single-process by definition).
 *
 * Mirrors `FsSessionRepository`'s id validation so the in-memory impl
 * is a true behavioural twin of the FS one.
 */
export class InMemorySessionRepository implements SessionRepository {
  private readonly entries = new Map<string, SessionState>();

  /** Pre-seed the repository with sessions. Useful for test fixtures. */
  constructor(seed: readonly { id: string; state: SessionState }[] = []) {
    for (const e of seed) {
      assertValidSessionId(e.id);
      this.entries.set(e.id, Object.freeze({ ...e.state }));
    }
  }

  async read(id: string): Promise<SessionState | null> {
    assertValidSessionId(id);
    return this.entries.get(id) ?? null;
  }

  async save(id: string, state: SessionState): Promise<void> {
    assertValidSessionId(id);
    this.entries.set(id, Object.freeze({ ...state }));
  }

  async delete(id: string): Promise<void> {
    assertValidSessionId(id);
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
