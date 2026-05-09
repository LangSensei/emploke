import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { CatalogManager } from "@emploke/catalog";
import { silentLogger } from "@emploke/logger";
import type { LaunchCommand, Runtime, RuntimeRegistry, Session } from "@emploke/runtime";
import { readAgentName } from "./agent-file.js";
import {
  AgentNotFoundError,
  SessionIdAllocationFailedError,
  SessionNotFoundError,
} from "./errors.js";
import { assertValidSessionId, generateSessionId } from "./ids.js";
import { safeJoinUnderRoot } from "./paths.js";
import { FsSessionRepository } from "./repositories/fs-session-repository.js";
import type { SessionRepository, SessionState } from "./repositories/repository.js";
import type {
  CreateSessionOpts,
  DeleteSessionOpts,
  ListSessionOpts,
  Logger,
  SessionManagerConfig,
} from "./types.js";

const DEFAULT_RUNTIME = "copilot";
const MAX_CREATE_RETRIES = 5;

/**
 * Per-session workdir manager, parameterised over a set of CLI runtimes
 * and a `SessionRepository` (defaults to `FsSessionRepository` rooted
 * at `sessionsDir`).
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
  private readonly repository: SessionRepository;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;

  constructor(config: SessionManagerConfig) {
    this.catalog = config.catalog;
    this.runtimeRegistry = config.runtimeRegistry;
    this.defaultRuntime = config.defaultRuntime ?? DEFAULT_RUNTIME;
    this.sessionsDir = path.resolve(config.sessionsDir);
    this.repository =
      config.repository ?? new FsSessionRepository({ sessionsDir: this.sessionsDir });
    this.logger = config.logger ?? silentLogger;
    this.now = config.now ?? (() => new Date());
    this.randomBytes = config.randomBytes ?? defaultRandomBytes;
  }

  // ─── create ──────────────────────────────────────────────

  async create(opts: CreateSessionOpts): Promise<Session> {
    const agentName = opts.agent;
    if (typeof agentName !== "string" || agentName.length === 0) {
      throw new AgentNotFoundError(String(agentName));
    }

    let resolveResult: ReturnType<CatalogManager["resolveAgent"]>;
    try {
      resolveResult = this.catalog.resolveAgent(agentName);
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
      const { runtimeSessionId } = await runtime.provision(workdir, resolveResult, this.catalog);
      const createdAt = this.now().toISOString();
      const state: SessionState = {
        runtime: runtime.kind,
        createdAt,
        runtimeSessionId,
      };
      await this.repository.save(id, state);
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
    return this.loadSession(id);
  }

  // ─── delete ──────────────────────────────────────────────

  async delete(id: string, opts: DeleteSessionOpts = {}): Promise<void> {
    assertValidSessionId(id);

    const session = await this.loadSession(id);
    if (session === null) {
      throw new SessionNotFoundError(id);
    }

    if (opts.deleteRuntimeState) {
      const runtime = this.runtimeRegistry.get(session.runtime);
      await runtime.deleteState(session);
    }

    await this.repository.delete(id);
    if (opts.purge === true) {
      const workdir = safeJoinUnderRoot(this.sessionsDir, id);
      await rm(workdir, { recursive: true, force: true });
    }
  }

  // ─── buildLaunch ─────────────────────────────────────────

  async buildLaunch(id: string): Promise<LaunchCommand> {
    assertValidSessionId(id);
    const session = await this.loadSession(id);
    if (session === null) throw new SessionNotFoundError(id);

    const runtime = this.runtimeRegistry.get(session.runtime);
    return runtime.buildLaunch(session);
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
    };
  }

  private async refreshSession(draft: Session): Promise<Session> {
    const runtime = this.runtimeRegistry.get(draft.runtime);

    let refreshed: Awaited<ReturnType<Runtime["refresh"]>>;
    try {
      refreshed = await runtime.refresh(draft);
    } catch (err) {
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

    if (refreshed.runtimeSessionId !== draft.runtimeSessionId) {
      try {
        await this.repository.save(draft.id, {
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
      }
    }

    return {
      ...draft,
      runtimeSessionId: refreshed.runtimeSessionId,
      lastActiveAt: refreshed.lastActiveAt,
      preview: refreshed.preview,
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
