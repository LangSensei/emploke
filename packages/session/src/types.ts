import type { CatalogQueries } from "@emploke/catalog";
import type { Logger } from "@emploke/logger";
import type { RuntimeRegistry } from "@emploke/runtime";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";

/** Re-export `LaunchCommand` so call sites only need one import. */
export type { LaunchCommand } from "@emploke/runtime";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Wire-level session value — combines the persisted row with workdir
 * (computed from layout), live `lastActiveAt` + `preview` from the
 * runtime, and the `lastLaunchMode` UI hint.
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
  readonly lastLaunchMode: "local" | "remote" | null;
}

/**
 * Configuration for SessionManager. After the de-DDD simplification,
 * persistence is supplied directly as an `EntityManager` (one EM per
 * workspace, owned by the @emploke/core orchestrator). The manager
 * builds a `SessionRepository` internally.
 */
export interface SessionManagerConfig {
  /** Catalog used to resolve agents at create() time. */
  readonly catalog: CatalogQueries;
  /** Registry of runtime adapters; must contain at least the default runtime. */
  readonly runtimeRegistry: RuntimeRegistry;
  /** Runtime kind used by `create()` when none is supplied. Defaults to `"copilot"`. */
  readonly defaultRuntime?: string;
  /**
   * Absolute directory under which per-session workdirs are created.
   * In production this is `<workspace>/sessions/` (from `workspaceLayout`).
   */
  readonly sessionsDir: string;
  /** Absolute path of the workspace this manager belongs to. */
  readonly workspaceDir: string;
  /**
   * Workspace UUID this manager belongs to. Surfaced as
   * `EMPLOKE_WORKSPACE` in the env bag of every interactive session
   * launch. Optional for tests that don't need workspace identity.
   */
  readonly workspaceId?: string;
  /**
   * Static env overrides merged into every session-launch env bag.
   * Production wires this from the server with `EMPLOKE_SERVER` and
   * `EMPLOKE_SHARED_DIR`.
   */
  readonly subprocessEnv?: NodeJS.ProcessEnv;
  /**
   * Drizzle-wrapped better-sqlite3 connection backing the `sessions`
   * table.
   */
  readonly db: Db;
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
  /** Runtime kind. Defaults to `SessionManagerConfig.defaultRuntime`. */
  readonly runtime?: string;
}

/** Options for `SessionManager.buildInteractiveLaunch`. */
export interface BuildInteractiveLaunchSessionOpts {
  /**
   * If `true`, ask the runtime to enable remote control. Runtimes that
   * don't support remote throw `RuntimeDoesNotSupportRemoteError`.
   */
  readonly remote?: boolean;
}

/** Options for SessionManager.list. */
export interface ListSessionOpts {
  /** Filter to sessions whose agent FQN matches exactly. */
  readonly agent?: string;
  /** Drop sessions whose `createdAt` is strictly before this ISO timestamp. */
  readonly createdSince?: string;
  /**
   * Drop sessions whose `lastActiveAt` is strictly before this ISO
   * timestamp. Applied after `runtime.refresh()`. Never-launched
   * sessions pass iff their `createdAt >= activeSince`.
   */
  readonly activeSince?: string;
}

/** Options for SessionManager.delete. */
export interface DeleteSessionOpts {
  /**
   * If `true`, full purge: remove the row, the per-session workdir, and
   * ask the runtime to drop its own per-session state. Default `false`
   * (archive): only the row is removed; workdir contents and runtime
   * state preserved. Same default semantics as
   * `WorkspaceManager.unregister({ purge })` and
   * `TaskManager.delete({ purge })`.
   */
  readonly purge?: boolean;
}
