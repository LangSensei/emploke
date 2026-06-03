import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AgentContentSource,
  LaunchCommand,
  ResolvedAgent,
  Runtime,
  RuntimeRegistry,
} from "@emploke/runtime";
import pino, { type Logger } from "pino";
import {
  AgentNotFoundError,
  AgentResolutionFailedError,
  SessionIdAllocationFailedError,
  SessionNotFoundError,
} from "./errors.js";
import { safeJoinUnderRoot, sessionsRoot } from "./paths.js";
import type { AgentResolverPort, SpawnFn } from "./ports.js";
import type { SessionEntity } from "./session-entity.js";
import { SessionRepository } from "./session-repository.js";
import type {
  BuildInteractiveLaunchSessionOpts,
  CreateSessionOpts,
  DeleteSessionOpts,
  ListSessionOpts,
  Session,
  SessionServiceConfig,
  SpawnSessionResult,
} from "./types.js";
import { assertValidSessionId, generateSessionId } from "./validate.js";

const silentLogger = pino({ level: "silent" });

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
 * Each method is a plain async function that combines the repository,
 * the runtime adapter, and on-disk workdir operations directly.
 */
export class SessionService {
  private readonly agentResolver: AgentResolverPort;
  private readonly contentSource: AgentContentSource;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly sessionsDir: string;
  private readonly workspaceDir: string;
  private readonly workspaceId: string;
  private readonly repo: SessionRepository;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;
  private readonly spawnFn: SpawnFn | undefined;

  constructor(config: SessionServiceConfig) {
    this.agentResolver = config.agentResolver;
    this.contentSource = config.contentSource;
    this.runtimeRegistry = config.runtimeRegistry;
    this.workspaceDir = path.resolve(config.workspaceDir);
    this.sessionsDir = sessionsRoot(this.workspaceDir);
    this.workspaceId = config.workspaceId;
    this.logger = config.logger ?? silentLogger;
    this.repo = new SessionRepository({ db: config.db });
    this.now = config.now ?? (() => new Date());
    this.randomBytes = config.randomBytes ?? defaultRandomBytes;
    this.spawnFn = config.spawnFn;
  }

  // ─── create ──────────────────────────────────────────────

  async create(opts: CreateSessionOpts): Promise<Session> {
    const agentName = opts.agent;
    if (typeof agentName !== "string" || agentName.length === 0) {
      throw new AgentNotFoundError(String(agentName));
    }

    // First check existence via `getAgentEntry` (null = not in
    // catalog → 400 AgentNotFoundError); only then resolve. Any throw
    // from `resolveAgent` is a system fault (500
    // AgentResolutionFailedError). If the agent disappears between the
    // two calls (TOCTOU), the failure surfaces as the 500 path — the
    // caller sees "resolution failed" rather than "not found".
    const entry = await this.agentResolver.getAgentEntry(agentName);
    if (entry === null) {
      throw new AgentNotFoundError(agentName);
    }
    let resolveResult: ResolvedAgent;
    try {
      resolveResult = await this.agentResolver.resolveAgent(agentName);
    } catch (err) {
      throw new AgentResolutionFailedError(agentName, err);
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

    let provisionedRuntimeSessionId: string | null = null;
    try {
      const { runtimeSessionId } = await runtime.provision(
        workdir,
        resolveResult,
        this.contentSource,
        {
          workspaceDir: this.workspaceDir,
        },
      );
      provisionedRuntimeSessionId = runtimeSessionId;
      const createdAt = this.now().toISOString();
      // Catalog is the source of truth for the canonical agent FQN —
      // `resolveResult.agent.fqn` already carries the `<scope>/<name>`
      // form (e.g. `"public/demo"` when the user passed the alias
      // `"demo"`). No need to re-read AGENTS.md off disk.
      const canonicalAgent = resolveResult.agent.fqn;
      await this.repo.insert({
        id,
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
      // Roll back in reverse order: remove the workdir, then ask the
      // runtime to drop whatever state it may have written under
      // <copilotStateDir>/<runtimeSessionId>/ during provision. Both
      // steps are best-effort: cleanup failures are logged but the
      // original error is what propagates to the caller.
      await safeRm(workdir, this.logger);
      if (provisionedRuntimeSessionId !== null) {
        try {
          await runtime.deleteState(provisionedRuntimeSessionId);
        } catch (cleanupErr) {
          this.logger.warn(
            {
              sessionId: id,
              runtimeSessionId: provisionedRuntimeSessionId,
              err: cleanupErr,
            },
            "session create: runtime state cleanup failed during rollback",
          );
        }
      }
      throw err;
    }
  }

  // ─── list ────────────────────────────────────────────────

  async list(opts: ListSessionOpts = {}): Promise<Session[]> {
    const repoOpts: { createdSince?: string; agent?: string } = {};
    if (opts.createdSince !== undefined) repoOpts.createdSince = opts.createdSince;
    if (opts.agent !== undefined) repoOpts.agent = opts.agent;
    let entries: SessionEntity[];
    try {
      entries = await this.repo.list(repoOpts);
    } catch (err) {
      this.logger.warn({ err }, "sessions: repository.list failed");
      return [];
    }

    const drafts = await Promise.all(entries.map((row) => this.draftFromEntity(row)));
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
            err,
          },
          "sessions: failed to persist lastLaunchMode",
        );
      }
    }

    return launchWithEnv;
  }

  // ─── spawnInteractive ───────────────────────────────────────────────

  /**
   * Build the session's interactive launch command via
   * {@link SessionService.buildInteractiveLaunch} and immediately hand
   * it to the injected `spawnFn` (in production, `spawnTerminal` from
   * `@emploke/terminal`, wired by `@emploke/api`'s composition root).
   *
   * The returned `display` field is always populated so callers can
   * show a copy-paste command even on spawn failure. The `code` field
   * carries a stable error-class name string when the call fails:
   *   - `"BuildLaunchError"` (or the upstream `err.name`) when
   *     `buildInteractiveLaunch` throws — `display` is empty in this
   *     case because no launch command was produced.
   *   - `"SpawnError"` (or the upstream `err.name`) when the injected
   *     `spawnFn` throws. For terminal-pkg errors
   *     (`NoTerminalFoundError`, `TerminalSpawnFailedError`,
   *     `UnsupportedPlatformError`), the class's stable `name`
   *     property (set as `override readonly name = "..."`) flows
   *     through unchanged.
   *
   * Throws (rather than returning `{ ok: false }`) only when no
   * `spawnFn` was supplied at compose time — i.e. misconfiguration
   * of the composition root, not a runtime spawn failure.
   */
  async spawnInteractive(
    id: string,
    opts: BuildInteractiveLaunchSessionOpts = {},
  ): Promise<SpawnSessionResult> {
    if (this.spawnFn === undefined) {
      throw new Error(
        "SessionService.spawnInteractive: no spawnFn was injected at compose time " +
          "(composeSessionModule must pass `spawnFn`)",
      );
    }
    // buildInteractiveLaunch can throw (e.g.
    // RuntimeDoesNotSupportRemoteError, TrustRegistrationFailed,
    // ENOENT on a stale runtimeSessionId). The SpawnSessionResult
    // contract documents that `display` is ALWAYS present so the
    // dashboard can show a copy-paste fallback even on failure —
    // wrapping only the spawn step would let a build-side throw
    // skip past the result-shape entirely.
    let cmd: LaunchCommand;
    try {
      cmd = await this.buildInteractiveLaunch(id, {
        ...(opts.remote === true ? { remote: true } : {}),
      });
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof Error && err.name ? err.name : "BuildLaunchError",
        display: "",
      };
    }
    try {
      const result = await this.spawnFn(cmd);
      return {
        ok: true as const,
        launcher: result.launcher,
        display: cmd.display,
      };
    } catch (err) {
      // Map by `err.name` only — no `instanceof` against terminal-pkg
      // classes — so this pkg can honour the architecture fence and
      // avoid value-importing `@emploke/terminal`. The terminal pkg's
      // error classes all set `override readonly name = "..."`, so
      // reading `err.name` returns the same stable string an
      // `instanceof` branch would select.
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof Error && err.name ? err.name : "SpawnError",
        display: cmd.display,
      };
    }
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

  // ─── internals ───────────────────────────────────────────

  private async draftFromEntity(entity: SessionEntity): Promise<Session | null> {
    const workdir = safeJoinUnderRoot(this.sessionsDir, entity.id);

    try {
      this.runtimeRegistry.get(entity.runtime);
    } catch (err) {
      this.logger.warn(
        {
          sessionId: entity.id,
          runtime: entity.runtime,
          err,
        },
        "sessions: skipping session with unregistered runtime",
      );
      return null;
    }

    return {
      id: entity.id,
      workdir,
      agent: entity.agent,
      runtime: entity.runtime,
      runtimeSessionId: entity.runtimeSessionId,
      createdAt: entity.createdAt,
      lastActiveAt: null,
      preview: null,
      lastLaunchMode: entity.lastLaunchMode,
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
          err,
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
    let row: SessionEntity | undefined;
    try {
      row = await this.repo.findById(id);
    } catch (err) {
      this.logger.warn(
        {
          sessionId: id,
          err,
        },
        "sessions: repository.read failed",
      );
      return null;
    }
    if (row === undefined) return null;
    const draft = await this.draftFromEntity(row);
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
        err,
      },
      "sessions: failed to remove workdir during cleanup",
    );
  }
}

function defaultRandomBytes(n: number): Buffer {
  return cryptoRandomBytes(n);
}
