import type { CatalogManager } from "@emploke/catalog";
import type { Logger } from "@emploke/logger";
import type { RuntimeRegistry } from "@emploke/runtime";
import type { SessionRepository } from "./repositories/repository.js";

/**
 * Re-export the canonical `Logger` from `@emploke/logger` for source
 * compatibility with callers that previously imported it from
 * `@emploke/session` directly.
 */
export type { Logger } from "@emploke/logger";

/** Re-export `LaunchCommand` so call sites only need one import. */
export type { LaunchCommand } from "@emploke/runtime";

/**
 * The wire-level session value type — a derived view that combines
 * the persisted {@link Session} entity (runtime / createdAt /
 * runtimeSessionId / lastLaunchMode) with three other sources:
 *   - `workdir`: computed from the workspace layout
 *   - `agent`: parsed from `<workdir>/AGENTS.md` frontmatter
 *   - `lastActiveAt` / `preview`: refreshed live from the runtime per call
 *
 * `SessionView` is what `SessionManager.list()` / `.get()` returns and
 * what `c.json(session)` ships down the HTTP wire to the dashboard.
 *
 * Owned by `@emploke/session` (the Runtime layer is intentionally
 * domain-agnostic and doesn't know what a "session" is — it just sees
 * opaque `runtimeSessionId`s).
 */
export interface SessionView {
  readonly id: string;
  readonly workdir: string;
  readonly agent: string;
  readonly runtime: string;
  readonly runtimeSessionId: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string | null;
  readonly preview: string | null;
  /**
   * Mode the user chose for the most recent successful launch of this
   * session, or `null` if it has never been launched. Defaults the
   * dashboard's Resume button to the user's last intent.
   */
  readonly lastLaunchMode: "local" | "remote" | null;
}

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
   * Threaded through `buildInteractiveLaunch` to the runtime so runtimes whose
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
   * Persistence backend for session state. Required: callers (server
   * `WorkspaceContext` in production, tests) construct a
   * `SqliteSessionRepository({ db: <workspace.db connection> })` and
   * pass it. There is no default — the session pkg no longer owns a DB
   * file path; the workspace pkg does.
   */
  readonly repository: SessionRepository;
  /** Optional logger. Defaults to silent. */
  readonly logger?: Logger;
  /** Test seam: clock for ID generation. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Test seam: random byte source for ID generation. Defaults to `crypto.randomBytes`. */
  readonly randomBytes?: (n: number) => Buffer;
}

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
 * Options for `SessionManager.buildInteractiveLaunch`. The session's persisted
 * record is unchanged across calls — these flags only modify how the
 * runtime renders the launch command this time around. The dashboard
 * sets these from the user's choice of "Spawn local" vs "Spawn remote"
 * button so the same session can be launched either way.
 */
export interface BuildInteractiveLaunchSessionOpts {
  /**
   * If `true`, ask the runtime to enable remote control of the
   * interactive session (browser / mobile steering). Forwarded to
   * `Runtime.buildInteractiveLaunch`'s `BuildInteractiveLaunchOpts.remote`. The runtime
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
   * If `true`, perform a full purge: remove the session's metadata
   * row, the per-session workdir under `<sessionsDir>/<id>/`
   * (AGENTS.md, agent-produced files, ...), AND ask the runtime
   * adapter to drop its own per-session state (e.g. for copilot,
   * `~/.copilot/session-state/<runtimeSessionId>/`).
   *
   * Defaults to `false` ("archive"): only the metadata row is removed
   * — workdir contents and runtime state are preserved on disk so the
   * user can recover or inspect them later. Same default semantics as
   * `WorkspaceManager.delete({ purge })` and
   * `TaskManager.delete({ purge })` — a single verb across all the
   * entity managers.
   *
   * The runtime-state cleanup runs *before* the workdir is removed; a
   * runtime failure leaves both the workdir AND the metadata row
   * intact so the user can retry without partial state.
   */
  readonly purge?: boolean;
}
