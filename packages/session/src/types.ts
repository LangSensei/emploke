import type { AgentContentSource, RuntimeRegistry } from "@emploke/runtime";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import type { AgentResolverPort } from "./ports.js";
import type * as schema from "./schema.js";

/** Re-export `LaunchCommand` so call sites only need one import. */
export type { LaunchCommand } from "@emploke/runtime";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Wire-level session value — combines the persisted row with workdir
 * (computed from layout), live `lastActiveAt` + `preview` from the
 * runtime, and the `lastLaunchMode` UI hint.
 */
export interface Session {
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
 * Configuration for SessionService. After the de-DDD simplification,
 * persistence is supplied directly as a Drizzle handle (one per
 * workspace, owned by the @emploke/core orchestrator).
 */
export interface SessionServiceConfig {
  /** Resolves agents at create() time (structural — catalog satisfies it). */
  readonly agentResolver: AgentResolverPort;
  /**
   * Provides agent / skill / mcp bytes for `runtime.provision` to
   * materialise into the workdir. Catalog satisfies this structurally;
   * the type lives in `@emploke/runtime` so this package depends on
   * catalog only via structural typing.
   */
  readonly contentSource: AgentContentSource;
  /** Registry of runtime adapters; must contain at least the default runtime. */
  readonly runtimeRegistry: RuntimeRegistry;
  /** Absolute path of the workspace this manager belongs to. */
  readonly workspaceDir: string;
  /**
   * Workspace UUID this manager belongs to. Surfaced as
   * `EMPLOKE_WORKSPACE` in the env bag of every interactive session
   * launch.
   */
  readonly workspaceId: string;
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

/** Options for SessionService.create. */
export interface CreateSessionOpts {
  /** Catalog agent name. */
  readonly agent: string;
  /** Runtime kind. Defaults to `"copilot"`. */
  readonly runtime?: string;
}

/** Options for `SessionService.buildInteractiveLaunch`. */
export interface BuildInteractiveLaunchSessionOpts {
  /**
   * If `true`, ask the runtime to enable remote control. Runtimes that
   * don't support remote throw `RuntimeDoesNotSupportRemoteError`.
   */
  readonly remote?: boolean;
}

/** Options for SessionService.list. */
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

/** Options for SessionService.delete. */
export interface DeleteSessionOpts {
  /**
   * If `true`, full purge: remove the row, the per-session workdir, and
   * ask the runtime to drop its own per-session state. Default `false`
   * (archive): only the row is removed; workdir contents and runtime
   * state preserved. Same default semantics as
   * `WorkspaceService.unregister({ purge })` and
   * `TaskService.delete({ purge })`.
   */
  readonly purge?: boolean;
}
