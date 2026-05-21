import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { CatalogService } from "@emploke/catalog";
import type { Logger } from "pino";
import pino from "pino";

const silentLogger = pino({ level: "silent" });

import type { LaunchCommand, Runtime, RuntimeRegistry } from "@emploke/runtime";

import {
  AgentNotFoundError,
  SessionIdAllocationFailedError,
  SessionNotFoundError,
} from "./errors.js";
import { safeJoinUnderRoot, sessionsRoot } from "./paths.js";
import type { SessionRow } from "./schema.js";
import { SessionRepository } from "./session-repository.js";
import type {
  BuildInteractiveLaunchSessionOpts,
  CreateSessionOpts,
  DeleteSessionOpts,
  ListSessionOpts,
  Session,
  SessionServiceConfig,
} from "./types.js";
import { assertValidSessionId, generateSessionId } from "./validate.js";

const DEFAULT_RUNTIME = "copilot";
const MAX_CREATE_RETRIES = 5;

/**
 * Per-session workdir manager.
 *
 * Persistence is backed by Drizzle via `SessionRepository` against the
 * per-workspace `workspace.db`. Live activity (`lastActiveAt`,
 * `preview`) is recomputed per call from the runtime registry; workdir
 * paths are resolved from the workspace layout.
 *
 * The manager owns no DDD ceremony: no aggregate factories, no value
 * objects, no domain events, no command/handler indirection. Each
 * method is a plain async function that combines the repository, the
 * runtime adapter, and on-disk workdir operations directly.
 */
export class SessionService {
  private readonly catalog: CatalogService;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly sessionsDir: string;
  private readonly workspaceDir: string;
  private readonly workspaceId: string;
  private readonly repo: SessionRepository;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;

  constructor(config: SessionServiceConfig) {
    this.catalog = config.catalog;
    this.runtimeRegistry = config.runtimeRegistry;
    this.workspaceDir = path.resolve(config.workspaceDir);
    this.sessionsDir = sessionsRoot(this.workspaceDir);
    this.workspaceId = config.workspaceId;
    this.logger = config.logger ?? silentLogger;
    this.repo = new SessionRepository({ db: config.db });
    this.now = config.now ?? (() => new Date());
    this.randomBytes = config.randomBytes ?? defaultRandomBytes;
  }

  // ─── create ──────────────────────────────────────────────

  async create(opts: CreateSessionOpts): Promise<Session> {
    const agentName = opts.agent;
    if (typeof agentName !== "string" || agentName.length === 0) {
      throw new AgentNotFoundError(String(agentName));
    }

    let resolveResult: Awaited<ReturnType<CatalogService["resolveAgent"]>>;
    try {
      resolveResult = await this.catalog.resolveAgent(agentName);
    } catch (err) {
      throw new AgentNotFoundError(agentName, err as Error);
    }

    const runtimeKind = opts.runtime ?? DEFAULT_RUNTIME;
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
      // Catalog is the source of truth for the canonical agent FQN —
      // `resolveResult.agent.fqn` already carries the `<scope>/<name>`
      // form (e.g. `"public/demo"` when the user passed the alias
      // `"demo"`). No need to re-read AGENTS.md off disk.
      const canonicalAgent = resolveResult.agent.fqn;
      await this.repo.insert({
        id: id as string,
        agent: canonicalAgent,
        runtime: runtime.kind,
        createdAt,
        runtimeSessionId,
      });
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
    const repoOpts: { createdSince?: string; agent?: string } = {};
    if (opts.createdSince !== undefined) repoOpts.createdSince = opts.createdSince;
    if (opts.agent !== undefined) repoOpts.agent = opts.agent;
    let entries: SessionRow[];
    try {
      entries = await this.repo.list(repoOpts);
    } catch (err) {
      this.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "sessions: repository.list failed",
      );
      return [];
    }

    const drafts = await Promise.all(entries.map((row) => this.draftFromRow(row)));
    const survivors: Session[] = [];
    for (const draft of drafts) {
      if (draft === null) continue;
      survivors.push(draft);
    }

    const refreshed = await Promise.all(survivors.map((s) => this.refreshSession(s)));

    const filtered =
      opts.activeSince !== undefined
        ? refreshed.filter((s) => {
            const since = opts.activeSince as string;
            if (s.lastActiveAt !== null) return s.lastActiveAt >= since;
            return s.createdAt >= since;
          })
        : refreshed;

    // Never-launched sessions sort first (so a freshly created session is
    // immediately findable at the top of the list). Among never-launched,
    // newest createdAt first; among launched, most-recently-active first.
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
      // Order matters: do every fallible physical step BEFORE deleting
      // the row. If any step fails (runtime.deleteState raising
      // RuntimeStateDeletionFailed; `rm` raising EBUSY on Windows
      // when Copilot still owns the workdir; etc.) we surface the
      // error AND leave the row intact so the user can see which
      // sessions still need cleanup. Removing the row first would
      // orphan the directory and break the "purge is recoverable"
      // contract documented in the README.
      //
      // Within the physical steps, runtime state first then workdir:
      // partial cleanup is acceptable (rm -rf is mostly idempotent
      // on retry) and ordering this way means a runtime failure
      // leaves the workdir intact for diagnosis.
      const runtime = this.runtimeRegistry.get(session.runtime);
      if (session.runtimeSessionId !== null) {
        await runtime.deleteState(session.runtimeSessionId);
      }
      const workdir = safeJoinUnderRoot(this.sessionsDir, id);
      await rm(workdir, { recursive: true, force: true });
      await this.repo.delete(id);
      return;
    }

    // Archive (default): forget the row but leave its files behind.
    await this.repo.delete(id);
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

    const launchWithEnv: LaunchCommand = {
      ...launch,
      env: this.assembleLaunchEnv(id, session.workdir, launch.env),
    };

    // Best-effort: remember the user's last intent so the next dashboard
    // render can default the Resume button. Persisted only after launch
    // build succeeded — a failed save is logged but doesn't fail the call.
    const desiredMode: "local" | "remote" = opts.remote === true ? "remote" : "local";
    if (session.lastLaunchMode !== desiredMode) {
      try {
        await this.repo.patchLastLaunchMode(id, desiredMode);
      } catch (err) {
        this.logger.warn(
          {
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          },
          "sessions: failed to persist lastLaunchMode",
        );
      }
    }

    return launchWithEnv;
  }

  /**
   * Build the env bag layered onto the LaunchCommand returned by the
   * runtime. The runtime owns cross-cutting env (`EMPLOKE_SERVER`,
   * `EMPLOKE_SHARED_DIR`, ...) via `CopilotRuntimeConfig.subprocessEnvBase`
   * and provides it on `launch.env`; we layer session-context env on top.
   *
   * Order (later wins on key collision):
   *   1. Runtime-supplied env (from `launch.env`)
   *   2. Per-session: EMPLOKE_WORKSPACE / EMPLOKE_WORKSPACE_DIR / EMPLOKE_WORK_*
   */
  private assembleLaunchEnv(
    sessionId: string,
    sessionWorkdir: string,
    runtimeEnv: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (runtimeEnv !== undefined) {
      for (const [k, v] of Object.entries(runtimeEnv)) {
        out[k] = v;
      }
    }
    out.EMPLOKE_WORKSPACE = this.workspaceId;
    out.EMPLOKE_WORKSPACE_DIR = this.workspaceDir;
    out.EMPLOKE_WORK_KIND = "session";
    out.EMPLOKE_WORK_ID = sessionId;
    out.EMPLOKE_WORK_DIR = sessionWorkdir;
    return out;
  }

  // ─── close ───────────────────────────────────────────────

  /**
   * Released the manager's hold on the ORM. After `close()` the manager
   * must not be used. ORM lifecycle is owned by the caller — this is a
   * no-op today, retained for API symmetry with the rest of the pkg.
   */
  close(): void {
    // intentionally empty
  }

  // ─── internals ───────────────────────────────────────────

  private async draftFromRow(row: SessionRow): Promise<Session | null> {
    const workdir = safeJoinUnderRoot(this.sessionsDir, row.id);

    try {
      this.runtimeRegistry.get(row.runtime);
    } catch (err) {
      this.logger.warn(
        {
          sessionId: row.id,
          runtime: row.runtime,
          error: err instanceof Error ? err.message : String(err),
        },
        "sessions: skipping session with unregistered runtime",
      );
      return null;
    }

    return {
      id: row.id,
      workdir,
      agent: row.agent,
      runtime: row.runtime,
      runtimeSessionId: row.runtimeSessionId,
      createdAt: row.createdAt,
      lastActiveAt: null,
      preview: null,
      lastLaunchMode: row.lastLaunchMode,
    };
  }

  private async refreshSession(draft: Session): Promise<Session> {
    const runtime = this.runtimeRegistry.get(draft.runtime);
    if (typeof runtime.readMetadata !== "function" || draft.runtimeSessionId === null) {
      return draft;
    }

    let refreshed: Awaited<ReturnType<NonNullable<Runtime["readMetadata"]>>>;
    try {
      refreshed = await runtime.readMetadata(draft.runtimeSessionId);
    } catch (err) {
      this.logger.warn(
        {
          sessionId: draft.id,
          runtime: draft.runtime,
          error: err instanceof Error ? err.message : String(err),
        },
        "sessions: runtime readMetadata failed",
      );
      return draft;
    }
    if (refreshed === null) {
      return draft;
    }

    return {
      ...draft,
      lastActiveAt: refreshed.lastActiveAt ?? draft.lastActiveAt,
      preview: refreshed.title ?? draft.preview,
    };
  }

  private async loadSession(id: string): Promise<Session | null> {
    let row: SessionRow | undefined;
    try {
      row = await this.repo.read(id);
    } catch (err) {
      this.logger.warn(
        {
          sessionId: id,
          error: err instanceof Error ? err.message : String(err),
        },
        "sessions: repository.read failed",
      );
      return null;
    }
    if (row === undefined) return null;
    const draft = await this.draftFromRow(row);
    if (draft === null) return null;
    return this.refreshSession(draft);
  }
}

async function safeRm(p: string, logger: Logger): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      {
        path: p,
        error: err instanceof Error ? err.message : String(err),
      },
      "sessions: failed to remove workdir during cleanup",
    );
  }
}

function defaultRandomBytes(n: number): Buffer {
  return cryptoRandomBytes(n);
}

// Re-export public sub-utilities for callers that want them.
export { safeJoinUnderRoot } from "./paths.js";
export { assertValidSessionId, generateSessionId, SESSION_ID_RE } from "./validate.js";
