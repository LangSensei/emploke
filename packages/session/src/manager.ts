import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { CatalogManager } from "@emploke/catalog";
import { silentLogger } from "@emploke/logger";
import type { LaunchCommand, Runtime, RuntimeRegistry } from "@emploke/runtime";
import { readAgentName } from "./agent-file.js";
import {
  AgentNotFoundError,
  SessionIdAllocationFailedError,
  SessionNotFoundError,
} from "./errors.js";
import { assertValidSessionId, generateSessionId } from "./ids.js";
import { safeJoinUnderRoot } from "./paths.js";
import type { SessionRepository, SessionState } from "./repositories/repository.js";
import type {
  BuildInteractiveLaunchSessionOpts,
  CreateSessionOpts,
  DeleteSessionOpts,
  ListSessionOpts,
  Logger,
  Session,
  SessionManagerConfig,
} from "./types.js";

const DEFAULT_RUNTIME = "copilot";
const MAX_CREATE_RETRIES = 5;

/**
 * Per-session workdir manager, parameterised over a set of CLI runtimes
 * and a `SessionRepository`. Construction takes a fully-built repository
 * (in production, a `SqliteSessionRepository` backed by the workspace's
 * shared `workspace.db` connection); the manager itself never opens a
 * database.
 *
 * Each session has two stores: the *repository* holds the persistent
 * state (`runtime`, `createdAt`, `runtimeSessionId`); the *workdir* on
 * disk holds AGENTS.md plus any agent-produced files. The manager
 * combines them — together with `runtime.refresh()` for live activity —
 * into a full `Session` for downstream callers.
 */
export class SessionManager {
  private readonly catalog: CatalogManager;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly defaultRuntime: string;
  private readonly sessionsDir: string;
  private readonly workspaceDir: string;
  private readonly repository: SessionRepository;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;

  constructor(config: SessionManagerConfig) {
    this.catalog = config.catalog;
    this.runtimeRegistry = config.runtimeRegistry;
    this.defaultRuntime = config.defaultRuntime ?? DEFAULT_RUNTIME;
    this.sessionsDir = path.resolve(config.sessionsDir);
    this.workspaceDir = path.resolve(config.workspaceDir);
    this.logger = config.logger ?? silentLogger;
    this.repository = config.repository;
    this.now = config.now ?? (() => new Date());
    this.randomBytes = config.randomBytes ?? defaultRandomBytes;
  }

  // ─── create ──────────────────────────────────────────────

  async create(opts: CreateSessionOpts): Promise<Session> {
    const agentName = opts.agent;
    if (typeof agentName !== "string" || agentName.length === 0) {
      throw new AgentNotFoundError(String(agentName));
    }

    let resolveResult: Awaited<ReturnType<CatalogManager["resolveAgent"]>>;
    try {
      resolveResult = await this.catalog.resolveAgent(agentName);
    } catch (err) {
      throw new AgentNotFoundError(agentName, err as Error);
    }

    const runtimeKind = opts.runtime ?? this.defaultRuntime;
    const runtime = this.runtimeRegistry.get(runtimeKind);

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

    try {
      const { runtimeSessionId } = await runtime.provision(workdir, resolveResult, this.catalog, {
        workspaceDir: this.workspaceDir,
      });
      const createdAt = this.now().toISOString();
      const state: SessionState = {
        runtime: runtime.kind,
        createdAt,
        runtimeSessionId,
      };
      await this.repository.save(id, state);
      // Return the canonical fqn read back from the provisioned workdir,
      // not the caller-supplied input. They MAY differ — list() always
      // reports the on-disk fqn, and the two should agree so the UI
      // can match newly-created sessions to filter selections.
      const canonicalAgent = (await readAgentName(workdir)) ?? agentName;
      return {
        id,
        workdir,
        agent: canonicalAgent,
        runtime: runtime.kind,
        runtimeSessionId,
        createdAt,
        lastActiveAt: null,
        preview: null,
        lastLaunchMode: null,
      };
    } catch (err) {
      await safeRm(workdir, this.logger);
      throw err;
    }
  }

  // ─── list ────────────────────────────────────────────────

  async list(opts: ListSessionOpts = {}): Promise<Session[]> {
    const repoOpts: { createdSince?: string } = {};
    if (opts.createdSince !== undefined) repoOpts.createdSince = opts.createdSince;
    let entries: { id: string; state: SessionState }[];
    try {
      entries = await this.repository.list(repoOpts);
    } catch (err) {
      this.logger.warn("sessions: repository.list failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const drafts = await Promise.all(
      entries.map((entry) => this.draftFromState(entry.id, entry.state)),
    );

    const survivors: Session[] = [];
    for (const draft of drafts) {
      if (draft === null) continue;
      if (opts.agent !== undefined && draft.agent !== opts.agent) continue;
      survivors.push(draft);
    }

    const refreshed = await Promise.all(survivors.map((s) => this.refreshSession(s)));

    // `activeSince` is post-refresh because lastActiveAt is only known
    // after `runtime.refresh()`. A session passes the predicate if EITHER:
    //   - it has been launched at or after the cutoff (lastActiveAt ≥ X), OR
    //   - it was created at or after the cutoff and never launched
    //     (createdAt ≥ X && lastActiveAt === null).
    // The second arm matters for "today" / "7d" filters: a session you
    // just created should show up immediately, even though it has no
    // launch activity yet.
    const filtered =
      opts.activeSince !== undefined
        ? refreshed.filter((s) => {
            const since = opts.activeSince as string;
            if (s.lastActiveAt !== null) return s.lastActiveAt >= since;
            return s.createdAt >= since;
          })
        : refreshed;

    // Never-launched sessions (lastActiveAt === null) ALWAYS sort first
    // regardless of their createdAt — a freshly created session must be
    // immediately findable at the top of the list so the user can launch
    // it without scrolling past stale active sessions. Among never-launched
    // sessions, secondary sort by createdAt desc (newest first). Active
    // sessions sort below by lastActiveAt desc, ties broken by id desc
    // for stability.
    filtered.sort((a, b) => {
      const aNull = a.lastActiveAt === null;
      const bNull = b.lastActiveAt === null;
      if (aNull !== bNull) return aNull ? -1 : 1;
      if (aNull && bNull) {
        const d = b.createdAt.localeCompare(a.createdAt);
        return d !== 0 ? d : b.id.localeCompare(a.id);
      }
      const d = (b.lastActiveAt as string).localeCompare(a.lastActiveAt as string);
      return d !== 0 ? d : b.id.localeCompare(a.id);
    });
    return filtered;
  }

  // ─── get ─────────────────────────────────────────────────

  async get(id: string): Promise<Session | null> {
    assertValidSessionId(id);
    return this.loadSession(id);
  }

  // ─── delete ──────────────────────────────────────────────

  async delete(id: string, opts: DeleteSessionOpts = {}): Promise<void> {
    assertValidSessionId(id);

    const session = await this.loadSession(id);
    if (session === null) {
      throw new SessionNotFoundError(id);
    }

    if (opts.purge === true) {
      // Full purge: runtime state first (it can fail loudly and we want
      // to bail before we've started removing things). Only after it
      // succeeds do we drop the metadata row + workdir.
      const runtime = this.runtimeRegistry.get(session.runtime);
      if (session.runtimeSessionId !== null) {
        await runtime.deleteState(session.runtimeSessionId);
      }
      await this.repository.delete(id);
      const workdir = safeJoinUnderRoot(this.sessionsDir, id);
      await rm(workdir, { recursive: true, force: true });
      return;
    }

    // Archive (default): forget the entity but leave its files behind so
    // the user can recover the agent's product or runtime conversation.
    await this.repository.delete(id);
  }

  // ─── buildInteractiveLaunch ─────────────────────────────────────────

  async buildInteractiveLaunch(
    id: string,
    opts: BuildInteractiveLaunchSessionOpts = {},
  ): Promise<LaunchCommand> {
    assertValidSessionId(id);
    const session = await this.loadSession(id);
    if (session === null) throw new SessionNotFoundError(id);

    const runtime = this.runtimeRegistry.get(session.runtime);
    const launch = await runtime.buildInteractiveLaunch(
      session.runtimeSessionId,
      session.workdir,
      this.workspaceDir,
      {
        ...(opts.remote === true ? { remote: true } : {}),
      },
    );

    // Best-effort: remember the user's last intent for this session so
    // the next dashboard render can default the Resume button. Persisted
    // only after `buildInteractiveLaunch` succeeded — if the runtime threw (e.g.
    // RuntimeDoesNotSupportRemoteError), we shouldn't update intent.
    // A failed save is logged but does not fail the call: the launch
    // command is already valid and the worst case is the next page
    // refresh shows the previous default.
    //
    // Uses `patchLastLaunchMode` (a single-statement UPDATE) instead
    // of `read → save({...prev, lastLaunchMode})` so two concurrent
    // `buildInteractiveLaunch` calls for the same session id (e.g. "Resume Local"
    // in tab A and "Resume Remote" in tab B fired within the same
    // event-loop tick) cannot lose each other's writes to OTHER
    // persisted fields. Last writer of `lastLaunchMode` itself still
    // wins, which is the intended UX. See issue #56.
    const desiredMode: "local" | "remote" = opts.remote === true ? "remote" : "local";
    if (session.lastLaunchMode !== desiredMode) {
      try {
        await this.repository.patchLastLaunchMode(id, desiredMode);
      } catch (err) {
        this.logger.warn("sessions: failed to persist lastLaunchMode", {
          sessionId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return launch;
  }

  // ─── close ───────────────────────────────────────────────

  /**
   * Release the underlying repository handle. After `close()`, the
   * manager must not be used. Idempotent: calling twice is a no-op.
   *
   * Servers that swap or evict a `SessionManager` (e.g. `WorkspaceContextCache`
   * on workspace removal / cache reload) must call this so the SQLite
   * file handle releases — Windows requires it before the workspace
   * directory can be `rm`-ed.
   */
  close(): void {
    const repo = this.repository as { close?: () => void };
    if (typeof repo.close === "function") {
      try {
        repo.close();
      } catch {
        // best-effort
      }
    }
  }

  // ─── internals ───────────────────────────────────────────

  private async draftFromState(id: string, state: SessionState): Promise<Session | null> {
    const workdir = safeJoinUnderRoot(this.sessionsDir, id);

    const agent = await readAgentName(workdir);
    if (agent === null) {
      this.logger.warn("sessions: skipping dir without readable AGENTS.md", { sessionId: id });
      return null;
    }

    try {
      this.runtimeRegistry.get(state.runtime);
    } catch (err) {
      this.logger.warn("sessions: skipping session with unregistered runtime", {
        sessionId: id,
        runtime: state.runtime,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    return {
      id,
      workdir,
      agent,
      runtime: state.runtime,
      runtimeSessionId: state.runtimeSessionId,
      createdAt: state.createdAt,
      lastActiveAt: null,
      preview: null,
      lastLaunchMode: state.lastLaunchMode ?? null,
    };
  }

  private async refreshSession(draft: Session): Promise<Session> {
    const runtime = this.runtimeRegistry.get(draft.runtime);
    if (typeof runtime.readMetadata !== "function" || draft.runtimeSessionId === null) {
      // Runtime doesn't expose metadata, or we have no id to look up
      // (discovery-only runtime that hasn't launched yet) — leave the
      // draft untouched.
      return draft;
    }

    let refreshed: Awaited<ReturnType<NonNullable<Runtime["readMetadata"]>>>;
    try {
      refreshed = await runtime.readMetadata(draft.runtimeSessionId);
    } catch (err) {
      this.logger.warn("sessions: runtime readMetadata failed", {
        sessionId: draft.id,
        runtime: draft.runtime,
        error: err instanceof Error ? err.message : String(err),
      });
      return draft;
    }
    if (refreshed === null) {
      return draft;
    }

    return {
      ...draft,
      // Runtime supplies title via `title`; emploke's session API surfaces
      // this as `preview` (legacy field name). Map at the boundary so
      // session API consumers don't break — the rename is queued as a
      // separate breaking-change PR.
      lastActiveAt: refreshed.lastActiveAt ?? draft.lastActiveAt,
      preview: refreshed.title ?? draft.preview,
    };
  }

  private async loadSession(id: string): Promise<Session | null> {
    let state: SessionState | null;
    try {
      state = await this.repository.read(id);
    } catch (err) {
      this.logger.warn("sessions: repository.read failed", {
        sessionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (state === null) return null;
    const draft = await this.draftFromState(id, state);
    if (draft === null) return null;
    return this.refreshSession(draft);
  }
}

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
