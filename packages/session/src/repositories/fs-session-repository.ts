import { rm } from "node:fs/promises";
import path from "node:path";
import { readJson, safeReaddir, writeJsonAtomic } from "@emploke/fs";
import { InvalidSessionIdError, SessionCorruptedError } from "../errors.js";
import { SESSION_ID_RE } from "../ids.js";
import type { ListSessionStateOpts, SessionRepository, SessionState } from "./repository.js";

const SESSION_FILE_NAME = "session.json";
const CURRENT_SCHEMA_VERSION = 1;

/**
 * Filesystem implementation of `SessionRepository`. Each session
 * state lives at `<sessionsDir>/<id>/session.json`; deleting the
 * state removes only that file (the rest of the per-session workdir
 * is agent-owned and is the manager's `purge` concern, not the
 * repository's).
 *
 * The `schemaVersion` is wrapped on save / unwrapped on read; callers
 * see only the domain `SessionState` type.
 *
 * Defense-in-depth: every public method validates `id` against
 * `SESSION_ID_RE` before composing on-disk paths. The session manager
 * already validates upstream, but `FsSessionRepository` is exported
 * from `@emploke/session/testing` — direct callers (or future callers)
 * must not be able to escape `sessionsDir` via a malformed id.
 */
export class FsSessionRepository implements SessionRepository {
  private readonly sessionsDir: string;

  constructor(opts: { sessionsDir: string }) {
    this.sessionsDir = path.resolve(opts.sessionsDir);
  }

  async read(id: string): Promise<SessionState | null> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    const file = path.join(this.sessionsDir, id, SESSION_FILE_NAME);
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch (err) {
      throw new SessionCorruptedError(id, `unreadable session.json: ${(err as Error).message}`);
    }
    if (raw === null) return null;
    return parseSessionState(id, raw);
  }

  async save(id: string, state: SessionState): Promise<void> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    const file = path.join(this.sessionsDir, id, SESSION_FILE_NAME);
    const wire: Record<string, unknown> = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      runtime: state.runtime,
      createdAt: state.createdAt,
      runtimeSessionId: state.runtimeSessionId,
    };
    await writeJsonAtomic(file, wire);
  }

  async delete(id: string): Promise<void> {
    // Idempotent: invalid ids cannot match anything on disk anyway.
    // Returning silently mirrors `FsTaskRepository.delete`.
    if (!SESSION_ID_RE.test(id)) return;
    const file = path.join(this.sessionsDir, id, SESSION_FILE_NAME);
    await rm(file, { force: true });
  }

  async list(opts: ListSessionStateOpts = {}): Promise<{ id: string; state: SessionState }[]> {
    const names = (await safeReaddir(this.sessionsDir)).filter((n) => SESSION_ID_RE.test(n));
    const out: { id: string; state: SessionState }[] = [];
    await Promise.all(
      names.map(async (id) => {
        let state: SessionState | null;
        try {
          state = await this.read(id);
        } catch {
          // Corrupted session.json — surfaced via list-time logging in
          // the manager. The repository drops the entry rather than
          // failing the whole list call.
          return;
        }
        if (state === null) return;
        if (opts.createdSince !== undefined && state.createdAt < opts.createdSince) return;
        out.push({ id, state });
      }),
    );
    return out;
  }
}

function parseSessionState(id: string, raw: unknown): SessionState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SessionCorruptedError(id, "expected an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new SessionCorruptedError(id, schemaMismatchReason(obj.schemaVersion));
  }
  if (typeof obj.runtime !== "string" || obj.runtime.length === 0) {
    throw new SessionCorruptedError(id, "missing or invalid 'runtime'");
  }
  if (typeof obj.createdAt !== "string" || obj.createdAt.length === 0) {
    throw new SessionCorruptedError(id, "missing or invalid 'createdAt'");
  }
  const rsid = obj.runtimeSessionId;
  if (rsid !== null && typeof rsid !== "string") {
    throw new SessionCorruptedError(id, "'runtimeSessionId' must be string or null");
  }
  return {
    runtime: obj.runtime,
    createdAt: obj.createdAt,
    runtimeSessionId: rsid,
  };
}

function schemaMismatchReason(onDisk: unknown): string {
  if (typeof onDisk === "number" && Number.isFinite(onDisk)) {
    if (onDisk > CURRENT_SCHEMA_VERSION) {
      return `session.json was written by a newer emploke (schemaVersion ${onDisk}; this server supports ${CURRENT_SCHEMA_VERSION}). Upgrade the server to read it.`;
    }
    if (onDisk < CURRENT_SCHEMA_VERSION) {
      return `session.json was written by an older emploke (schemaVersion ${onDisk}; this server supports ${CURRENT_SCHEMA_VERSION}). Migration from older versions is not yet implemented.`;
    }
  }
  return `unsupported schemaVersion: ${JSON.stringify(onDisk)}`;
}
