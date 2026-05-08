import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Catalog } from "@emploke/catalog";
import type { LaunchCommand, Runtime, RuntimeRegistry, Session } from "@emploke/runtime";
import { readAgentName } from "./agent-file.js";
import {
  AgentNotFoundError,
  SessionIdAllocationFailedError,
  SessionNotFoundError,
} from "./errors.js";
import { assertValidSessionId, generateSessionId, SESSION_ID_RE } from "./ids.js";
import { safeJoinUnderRoot } from "./paths.js";
import {
  CURRENT_SCHEMA_VERSION,
  readPersistedSession,
  writePersistedSession,
} from "./session-file.js";
import type {
  CreateSessionOpts,
  DeleteSessionOpts,
  ListSessionOpts,
  Logger,
  PersistedSession,
  SessionManagerConfig,
} from "./types.js";

const SILENT_LOGGER: Logger = { warn: () => {} };
const DEFAULT_RUNTIME = "copilot";
const MAX_CREATE_RETRIES = 5;

/**
 * Per-session workdir registry, parameterised over a set of CLI runtimes.
 *
 * Owns the on-disk layout under `sessionsDir`. Each session is one directory,
 * holding:
 *
 *   - `AGENTS.md` — written by the runtime's provisioner (source of truth
 *     for the agent's persona; the agent name is read from its frontmatter)
 *   - `session.json` — the per-session state we persist (schema below)
 *   - whatever else the runtime's provisioner deposited
 *
 * Session manager itself does not spawn any subprocess; callers receive a
 * `LaunchCommand` and are responsible for execing it.
 *
 * Activity metadata (`lastActiveAt`, `preview`) is NOT persisted — it's
 * read fresh from the runtime on every list/get call. The cost is one
 * `runtime.refresh()` per session, which for copilot is a single yaml read.
 *
 * SessionManager has no notion of a "workspace". The caller (typically
 * `@emploke/server`) opens a workspace, then constructs one SessionManager
 * per workspace pointed at `<workspace>/sessions/`.
 */
export class SessionManager {
  private readonly catalog: Catalog;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly defaultRuntime: string;
  private readonly sessionsDir: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;

  constructor(config: SessionManagerConfig) {
    this.catalog = config.catalog;
    this.runtimeRegistry = config.runtimeRegistry;
    this.defaultRuntime = config.defaultRuntime ?? DEFAULT_RUNTIME;
    this.sessionsDir = path.resolve(config.sessionsDir);
    this.logger = config.logger ?? SILENT_LOGGER;
    this.now = config.now ?? (() => new Date());
    this.randomBytes = config.randomBytes ?? defaultRandomBytes;
  }

  // ─── create ──────────────────────────────────────────────

  async create(opts: CreateSessionOpts): Promise<Session> {
    const agentName = opts.agent;
    if (typeof agentName !== "string" || agentName.length === 0) {
      throw new AgentNotFoundError(String(agentName));
    }

    // 1. Resolve agent up-front. Bare-Error throws from the resolver are
    //    rewrapped as AgentNotFoundError — distinguishable to callers.
    let resolveResult: ReturnType<Catalog["resolveAgent"]>;
    try {
      resolveResult = this.catalog.resolveAgent(agentName);
    } catch (err) {
      throw new AgentNotFoundError(agentName, err as Error);
    }

    // 2. Pick the runtime. Throws UnknownRuntimeError if not registered.
    const runtimeKind = opts.runtime ?? this.defaultRuntime;
    const runtime = this.runtimeRegistry.get(runtimeKind);

    // 3. Reserve a workdir via exclusive mkdir, retrying on EEXIST.
    await mkdir(this.sessionsDir, { recursive: true });
    let id: string | null = null;
    let workdir: string | null = null;
    for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
      const candidateId = generateSessionId(this.now, this.randomBytes);
      const candidateDir = safeJoinUnderRoot(this.sessionsDir, candidateId);
      try {
        await mkdir(candidateDir, { recursive: false });
        id = candidateId;
        workdir = candidateDir;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        throw err;
      }
    }
    if (id === null || workdir === null) {
      throw new SessionIdAllocationFailedError(MAX_CREATE_RETRIES);
    }

    // 4. Provision and persist session.json. Atomic-ish: if anything fails,
    //    rmdir the workdir and rethrow.
    try {
      const { runtimeSessionId } = await runtime.provision(workdir, resolveResult);
      const createdAt = this.now().toISOString();
      const persisted: PersistedSession = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        runtime: runtime.kind,
        createdAt,
        runtimeSessionId,
      };
      await writePersistedSession(workdir, persisted);
      // Build the in-memory view. Activity fields start null; the user
      // hasn't launched yet.
      return {
        id,
        workdir,
        agent: agentName,
        runtime: runtime.kind,
        runtimeSessionId,
        createdAt,
        lastActiveAt: null,
        preview: null,
      };
    } catch (err) {
      await safeRm(workdir, this.logger);
      throw err;
    }
  }

  // ─── list ────────────────────────────────────────────────

  async list(opts: ListSessionOpts = {}): Promise<Session[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.sessionsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    // Two-pass load:
    //   1. Read session.json + AGENTS.md in parallel for every candidate dir.
    //      Each "draft" has agent/createdAt populated but lastActiveAt/preview
    //      still null. This pass is cheap (~2 file reads each).
    //   2. Apply the cheap filters (agent, createdSince) on the drafts.
    //   3. Run runtime.refresh() in parallel ONLY on survivors. This is the
    //      expensive bit (yaml read for copilot), so narrowing first matters
    //      a lot when the user has a small time window selected.
    const drafts = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && SESSION_ID_RE.test(e.name))
        .map((e) => {
          const id = e.name;
          const workdir = safeJoinUnderRoot(this.sessionsDir, id);
          return this.loadPersistent(id, workdir);
        }),
    );

    const survivors: Session[] = [];
    for (const draft of drafts) {
      if (draft === null) continue;
      if (opts.agent !== undefined && draft.agent !== opts.agent) continue;
      // ISO 8601 strings (Z-suffixed) sort lexicographically as dates.
      if (opts.createdSince !== undefined && draft.createdAt < opts.createdSince) continue;
      survivors.push(draft);
    }

    const refreshed = await Promise.all(survivors.map((s) => this.refreshSession(s)));

    // Sort newest-first by effective activity. lastActiveAt wins; createdAt
    // is the fallback for sessions that haven't been launched yet. Id is
    // the deterministic tiebreaker.
    refreshed.sort((a, b) => {
      const av = a.lastActiveAt ?? a.createdAt;
      const bv = b.lastActiveAt ?? b.createdAt;
      const d = bv.localeCompare(av);
      return d !== 0 ? d : b.id.localeCompare(a.id);
    });
    return refreshed;
  }

  // ─── get ─────────────────────────────────────────────────

  async get(id: string): Promise<Session | null> {
    assertValidSessionId(id);
    const workdir = safeJoinUnderRoot(this.sessionsDir, id);
    return this.loadSession(id, workdir);
  }

  // ─── delete ──────────────────────────────────────────────

  async delete(id: string, opts: DeleteSessionOpts = {}): Promise<void> {
    assertValidSessionId(id);
    const workdir = safeJoinUnderRoot(this.sessionsDir, id);

    const session = await this.loadSession(id, workdir);
    if (session === null) {
      throw new SessionNotFoundError(id);
    }

    if (opts.deleteRuntimeState) {
      const runtime = this.runtimeRegistry.get(session.runtime);
      // Propagates RuntimeStateDeletionFailed; workdir is left intact so
      // the user can retry.
      await runtime.deleteState(session);
    }

    await rm(workdir, { recursive: true, force: true });
  }

  // ─── buildLaunch ─────────────────────────────────────────

  /**
   * Build the shell command that drops the user into the runtime for
   * `session`. Refreshes activity first so that runtimes which mint ids
   * lazily (e.g. gemini-style) get a chance to update `runtimeSessionId`
   * before the launch command is built.
   */
  async buildLaunch(id: string): Promise<LaunchCommand> {
    assertValidSessionId(id);
    const workdir = safeJoinUnderRoot(this.sessionsDir, id);
    const session = await this.loadSession(id, workdir);
    if (session === null) throw new SessionNotFoundError(id);

    const runtime = this.runtimeRegistry.get(session.runtime);
    return runtime.buildLaunch(session);
  }

  // ─── internals ───────────────────────────────────────────

  /**
   * Read AGENTS.md + session.json and produce a "draft" Session with the
   * persistent fields populated and activity (`lastActiveAt`, `preview`)
   * left null. Cheap: 2 file reads, no runtime call.
   *
   * Returns null when the workdir is not a recognisable session (no
   * session.json, no AGENTS.md, no agent name in frontmatter, or the
   * declared runtime is not registered). Throws nothing — callers tolerate
   * null.
   */
  private async loadPersistent(id: string, workdir: string): Promise<Session | null> {
    const persistedRes = await readPersistedSession(workdir);
    if (persistedRes === null) {
      this.logger.warn("sessions: skipping dir without session.json", { sessionId: id });
      return null;
    }
    if (persistedRes.ok === false) {
      this.logger.warn("sessions: skipping corrupted session.json", {
        sessionId: id,
        reason: persistedRes.reason,
      });
      return null;
    }
    const persisted = persistedRes.value;

    const agent = await readAgentName(workdir);
    if (agent === null) {
      this.logger.warn("sessions: skipping dir without readable AGENTS.md", { sessionId: id });
      return null;
    }

    try {
      this.runtimeRegistry.get(persisted.runtime);
    } catch (err) {
      // The session declares a runtime that's not registered. Surface as a
      // warning and skip — listing should not blow up because of one stale
      // session.
      this.logger.warn("sessions: skipping session with unregistered runtime", {
        sessionId: id,
        runtime: persisted.runtime,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    return {
      id,
      workdir,
      agent,
      runtime: persisted.runtime,
      runtimeSessionId: persisted.runtimeSessionId,
      createdAt: persisted.createdAt,
      lastActiveAt: null,
      preview: null,
    };
  }

  /**
   * Call `runtime.refresh()` on a draft and fold the result in. If the
   * runtime returns a new `runtimeSessionId` (lazy mint), persist it back.
   * On refresh failure, returns the draft unchanged (activity stays null).
   *
   * Assumes the runtime is registered (loadPersistent already verified).
   */
  private async refreshSession(draft: Session): Promise<Session> {
    const runtime = this.runtimeRegistry.get(draft.runtime);

    let refreshed: Awaited<ReturnType<Runtime["refresh"]>>;
    try {
      refreshed = await runtime.refresh(draft);
    } catch (err) {
      // RuntimeRefreshFailed (or anything else) — surface as a warning and
      // return the draft. Activity stays null; the session is still listable.
      this.logger.warn("sessions: runtime refresh failed", {
        sessionId: draft.id,
        runtime: draft.runtime,
        error: err instanceof Error ? err.message : String(err),
      });
      return draft;
    }
    if (refreshed === null) {
      return draft;
    }

    // If the runtime discovered a new id (lazy mint), persist it back so we
    // don't have to re-discover next time.
    if (refreshed.runtimeSessionId !== draft.runtimeSessionId) {
      try {
        await writePersistedSession(draft.workdir, {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          runtime: draft.runtime,
          createdAt: draft.createdAt,
          runtimeSessionId: refreshed.runtimeSessionId,
        });
      } catch (err) {
        this.logger.warn("sessions: failed to persist discovered runtimeSessionId", {
          sessionId: draft.id,
          runtime: draft.runtime,
          error: err instanceof Error ? err.message : String(err),
        });
        // Soft-fail; in-memory record still reflects the new id.
      }
    }

    return {
      ...draft,
      runtimeSessionId: refreshed.runtimeSessionId,
      lastActiveAt: refreshed.lastActiveAt,
      preview: refreshed.preview,
    };
  }

  /**
   * Composite of loadPersistent + refreshSession. Used by `get()`,
   * `delete()`, and `buildLaunch()` where we want the full activity-folded
   * record. `list()` calls the two parts separately so it can apply cheap
   * filters before paying for refresh on excluded entries.
   */
  private async loadSession(id: string, workdir: string): Promise<Session | null> {
    const draft = await this.loadPersistent(id, workdir);
    if (draft === null) return null;
    return this.refreshSession(draft);
  }
}

// ─── module-private helpers ────────────────────────────────

/** Best-effort recursive remove. Logs (does not throw) on failure. */
async function safeRm(p: string, logger: Logger): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true });
  } catch (err) {
    logger.warn("sessions: failed to remove workdir during cleanup", {
      path: p,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function defaultRandomBytes(n: number): Buffer {
  return cryptoRandomBytes(n);
}

// Re-export public sub-utilities for callers that want them.
export { readAgentName } from "./agent-file.js";
export { assertValidSessionId, generateSessionId, SESSION_ID_RE } from "./ids.js";
export { safeJoinUnderRoot } from "./paths.js";
export {
  CURRENT_SCHEMA_VERSION,
  readPersistedSession,
  SESSION_FILE_NAME,
  writePersistedSession,
} from "./session-file.js";
