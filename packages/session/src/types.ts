import type { CatalogManager } from "@emploke/catalog";
import type { Logger } from "@emploke/logger";
import type { RuntimeRegistry, Session } from "@emploke/runtime";
import type { SessionRepository } from "./repositories/repository.js";

/**
 * Re-export the canonical `Logger` from `@emploke/logger` for source
 * compatibility with callers that previously imported it from
 * `@emploke/session` directly.
 */
export type { Logger } from "@emploke/logger";

/** Configuration for SessionManager. All fields are optional except `catalog`, `runtimeRegistry`, and `sessionsDir`. */
export interface SessionManagerConfig {
  /** Catalog used to resolve agents at create() time. */
  readonly catalog: CatalogManager;
  /** Registry of runtime adapters; must contain at least the default runtime. */
  readonly runtimeRegistry: RuntimeRegistry;
  /** Runtime kind used by `create()` when none is supplied. Defaults to `"copilot"`. */
  readonly defaultRuntime?: string;
  /**
   * Absolute directory under which per-session workdirs are created. Required.
   * In production this is `<workspace>/sessions/`; the server hands it through
   * after opening the workspace. SessionManager itself has no notion of a
   * "workspace" — it only knows about the directory you tell it to manage.
   */
  readonly sessionsDir: string;
  /**
   * Absolute path of the workspace this manager belongs to. Required.
   *
   * Threaded through `buildLaunch` to the runtime so runtimes whose
   * interactive launch needs a workspace-rooted preflight (e.g. Copilot
   * needs to ensure `workspaceDir` is in `~/.copilot/config.json`
   * `trustedFolders` to suppress its trust prompt) can run that
   * preflight at the moment of launch. Pure runtimes ignore the value.
   *
   * This is intentionally a peer of `sessionsDir` rather than derived
   * from it: the manager's lifetime is per-workspace by construction
   * and the server already knows both paths from `workspaceLayout()`.
   */
  readonly workspaceDir: string;
  /**
   * Persistence backend for session state. When omitted, the manager
   * constructs a `SqliteSessionRepository` opened at
   * `<sessionsDir>/sessions.db` automatically; tests can inject a
   * `:memory:`-backed `SqliteSessionRepository` (from
   * `@emploke/session/testing`) to keep state purely in-process.
   */
  readonly repository?: SessionRepository;
  /** Optional logger. Defaults to silent. */
  readonly logger?: Logger;
  /** Test seam: clock for ID generation. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Test seam: random byte source for ID generation. Defaults to `crypto.randomBytes`. */
  readonly randomBytes?: (n: number) => Buffer;
}

/** Re-export the runtime view of a session as the canonical session record. */
export type { LaunchCommand, Session } from "@emploke/runtime";

/** Options for SessionManager.create. */
export interface CreateSessionOpts {
  /** Catalog agent name. */
  readonly agent: string;
  /**
   * Runtime kind to use. Defaults to `SessionManagerConfig.defaultRuntime`,
   * which itself defaults to `"copilot"`.
   */
  readonly runtime?: string;
}

/**
 * Options for `SessionManager.buildLaunch`. The session's persisted
 * record is unchanged across calls — these flags only modify how the
 * runtime renders the launch command this time around. The dashboard
 * sets these from the user's choice of "Spawn local" vs "Spawn remote"
 * button so the same session can be launched either way.
 */
export interface BuildLaunchSessionOpts {
  /**
   * If `true`, ask the runtime to enable remote control of the
   * interactive session (browser / mobile steering). Forwarded to
   * `Runtime.buildLaunch`'s `BuildLaunchOpts.remote`. The runtime
   * throws `RuntimeDoesNotSupportRemoteError` if it doesn't support
   * the flag — the route layer maps that to HTTP 400.
   */
  readonly remote?: boolean;
}

/** Options for SessionManager.list. */
export interface ListSessionOpts {
  /** Filter to sessions whose AGENTS.md frontmatter name matches this exact value. */
  readonly agent?: string;
  /**
   * Drop sessions whose `createdAt` is strictly before this ISO 8601 timestamp.
   * Applied AFTER reading session.json + AGENTS.md but BEFORE the (more expensive)
   * runtime.refresh() call, so excluded entries pay zero refresh cost.
   */
  readonly createdSince?: string;
  /**
   * Drop sessions whose `lastActiveAt` is strictly before this ISO 8601
   * timestamp. Applied AFTER `runtime.refresh()` (lastActiveAt only exists
   * post-refresh). Sessions that have never been launched
   * (`lastActiveAt === null`) are dropped by this filter — "never active"
   * fails the "active since X" predicate by definition.
   *
   * Use `createdSince` instead if you want a cheaper pre-refresh filter
   * keyed off creation time.
   */
  readonly activeSince?: string;
}

/** Options for SessionManager.delete. */
export interface DeleteSessionOpts {
  /**
   * If true, ask the runtime to also remove its own per-session state (e.g.
   * for copilot, this is `~/.copilot/session-state/<runtimeSessionId>/`).
   * Performed *before* the workdir is removed; a runtime failure leaves
   * the workdir intact so the user can retry.
   */
  readonly deleteRuntimeState?: boolean;
  /**
   * If true, also remove the entire per-session workdir under
   * `<sessionsDir>/<id>/` (including AGENTS.md, agent-produced files,
   * etc.). Defaults to `false`: only the metadata is removed; the
   * workdir contents are preserved for archival.
   *
   * Same semantics as `WorkspaceManager.delete({ purge })` and
   * `TaskManager.delete({ purge })` — a single verb across all the
   * entity managers.
   */
  readonly purge?: boolean;
}

/** Re-exported for callers that want to type-narrow. */
export type { Session as SessionRecord } from "@emploke/runtime";

// Internal helper used by tests and consumers; alias for parity with Runtime.
export type ManagedSession = Session;
